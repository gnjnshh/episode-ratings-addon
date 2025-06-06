const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const cache = new NodeCache({ stdTTL: 24 * 60 * 60 }); // 24-hour cache

// --- ADDON MANIFEST ---
const manifest = {
    id: 'community.imdb.episode.ratings.configurable',
    version: '2.0.0',
    name: 'IMDb Episode Ratings (Configurable)',
    description: 'Adds IMDb ratings to individual episodes. Requires user API keys.',
    resources: ['meta', 'manifest'],
    types: ['series'],
    idPrefixes: ['tt'],
    // Add behaviorHints to tell Stremio this addon is configurable
    behaviorHints: {
        configurable: true,
        // configurationRequired makes the "Configure" button more prominent
        // if the addon hasn't been configured yet.
        configurationRequired: true 
    }
};

// --- CORE LOGIC ---
const builder = new addonBuilder(manifest);

builder.defineMetaHandler(async (args) => {
    // Check if the user has provided API keys in the configuration.
    if (!args.config || !args.config.tmdbKey || !args.config.omdbKey) {
        // If not, return an error message prompting them to configure the addon.
        return Promise.reject("Configuration required. Please provide TMDB and OMDb API keys in the addon settings.");
    }

    const { tmdbKey, omdbKey } = args.config;
    const { type, id } = args;

    if (type !== 'series') {
        return { meta: null };
    }
    console.log(`Received meta request for series ID: ${id} with user config.`);

    const cachedMeta = cache.get(id);
    if (cachedMeta) {
        console.log(`Returning cached metadata for ${id}`);
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

        console.log(`Successfully processed ${id}. Caching result.`);
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


// --- VERCL ADAPTER ---
const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
    // Check if the request is for the configuration page
    if (req.url.startsWith('/configure')) {
        res.setHeader('Content-Type', 'text/html');
        // Construct the correct path to the config.html file.
        // In Vercel, the file will be in the parent directory of the 'api' folder at runtime.
        const filePath = path.join(process.cwd(), 'config.html');
        fs.createReadStream(filePath).pipe(res);
        return;
    }
    
    // For all other requests, use the addonInterface handler
    const { get } = require('stremio-addon-sdk/src/middleware');
    await get(addonInterface)(req, res);
};
