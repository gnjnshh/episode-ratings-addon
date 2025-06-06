const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

let configHtml = null;
try {
    const filePath = path.join(process.cwd(), 'config.html');
    configHtml = fs.readFileSync(filePath, 'utf-8');
} catch (error) {
    console.error("CRITICAL: Could not read config.html file.", error);
}

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const cache = new NodeCache({ stdTTL: 24 * 60 * 60 });

// --- ADDON MANIFEST ---
const manifest = {
    id: 'community.imdb.episode.ratings.configurable',
    version: '2.2.0', // Version bump for the fix
    name: 'IMDb Episode Ratings (Configurable)',
    description: 'Adds IMDb ratings to individual episodes. Requires user API keys.',
    
    // THE FIX: Remove "manifest" from this array
    resources: ['meta'],

    types: ['series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: true 
    }
};

// --- CORE LOGIC (No changes) ---
const builder = new addonBuilder(manifest);

builder.defineMetaHandler(async (args) => {
    if (!args.config || !args.config.tmdbKey || !args.config.omdbKey) {
        return Promise.reject("Configuration required. Please provide TMDB and OMDb API keys in the addon settings.");
    }

    const { tmdbKey, omdbKey } = args.config;
    const { type, id } = args;

    if (type !== 'series') {
        return { meta: null };
    }

    const cachedMeta = cache.get(id);
    if (cachedMeta) {
        return { meta: cachedMeta };
    }

    try {
        const seriesResponse = await axios.get(`${TMDB_BASE_URL}/tv/${id}?api_key=${tmdbKey}`);
        const seriesData = seriesResponse.data;

        const seasonPromises = seriesData.seasons.map(s =>
            axios.get(`${TMDB_BASE_URL}/tv/${id}/season/${s.season_number}?api_key=${tmdbKey}`)
        );
        const seasonResponses = await Promise.all(seasonPromises);
        const allEpisodes = seasonResponses.flatMap(res => res.data.episodes);

        const episodePromises = allEpisodes.map(episode =>
            getEpisodeRating(id, episode.season_number, episode.episode_number, tmdbKey, omdbKey)
        );
        const episodesWithRatings = (await Promise.all(episodePromises)).filter(Boolean);

        episodesWithRatings.sort((a, b) => {
            if (a.season !== b.season) return a.season - b.season;
            return a.episode - b.episode;
        });

        const meta = {
            id: id,
            type: 'series',
            name: seriesData.name,
            poster: seriesData.poster_path ? `https://image.tmdb.org/t/p/w500${seriesData.poster_path}` : null,
            background: seriesData.backdrop_path ? `https://image.tmdb.org/t/p/original${seriesData.backdrop_path}` : null,
            description: seriesData.overview,
            imdbRating: seriesData.vote_average ? seriesData.vote_average.toString() : null,
            videos: episodesWithRatings
        };

        cache.set(id, meta);
        return { meta };

    } catch (error) {
        console.error(`Error fetching metadata for ${id}:`, error.message);
        return Promise.reject(`Failed to fetch metadata for ${id}. Please check your API keys and try again.`);
    }
});

async function getEpisodeRating(seriesImdbId, seasonNumber, episodeNumber, tmdbKey, omdbKey) {
    const episodeCacheKey = `${seriesImdbId}:${seasonNumber}:${episodeNumber}`;
    const cachedEpisode = cache.get(episodeCacheKey);
    if (cachedEpisode) return cachedEpisode;

    try {
        const [tmdbEpisodeResponse, omdbResponse] = await Promise.all([
            axios.get(`${TMDB_BASE_URL}/tv/${seriesImdbId}/season/${seasonNumber}/episode/${episodeNumber}?api_key=${tmdbKey}`),
            axios.get(`http://www.omdbapi.com/?i=${seriesImdbId}&Season=${seasonNumber}&Episode=${episodeNumber}&apikey=${omdbKey}`)
        ]);

        const tmdbEpisode = tmdbEpisodeResponse.data;
        const omdbEpisode = omdbResponse.data;

        if (omdbEpisode.Response === "False") {
            throw new Error(omdbEpisode.Error);
        }

        const episodeObject = {
            id: `${seriesImdbId}:${seasonNumber}:${episodeNumber}`,
            title: tmdbEpisode.name || `Episode ${episodeNumber}`,
            season: seasonNumber,
            episode: episodeNumber,
            overview: tmdbEpisode.overview,
            thumbnail: tmdbEpisode.still_path ? `https://image.tmdb.org/t/p/w300${tmdbEpisode.still_path}` : null,
            released: new Date(tmdbEpisode.air_date),
            imdbRating: omdbEpisode.imdbRating && omdbEpisode.imdbRating !== 'N/A' ? omdbEpisode.imdbRating : null
        };

        cache.set(episodeCacheKey, episodeObject, 12 * 60 * 60);
        return episodeObject;

    } catch (error) {
        return null;
    }
}

// --- VERCL ADAPTER (No changes) ---
const { getRouter } = require("stremio-addon-sdk");
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

module.exports = (req, res) => {
    if (req.url.startsWith('/configure')) {
        if (configHtml) {
            res.setHeader('Content-Type', 'text/html');
            res.end(configHtml);
        } else {
            res.statusCode = 500;
            res.end('<h1>500 Internal Server Error</h1><p>The configuration file could not be loaded.</p>');
        }
        return;
    }
    
    router(req, res, () => {
        res.statusCode = 404;
        res.end();
    });
};
