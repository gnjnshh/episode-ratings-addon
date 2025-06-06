// No need for dotenv in production on Vercel, but useful for local testing
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');

// --- CONFIGURATION ---
const { TMDB_API_KEY, OMDB_API_KEY } = process.env;

if (!TMDB_API_KEY || !OMDB_API_KEY) {
    console.error("FATAL: Missing TMDB_API_KEY or OMDB_API_KEY from environment variables.");
}

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const cache = new NodeCache({ stdTTL: 24 * 60 * 60 }); // 24-hour cache

// --- ADDON MANIFEST (No changes here) ---
const manifest = {
    id: 'community.imdb.episode.ratings',
    version: '1.0.1', // Incremented version
    name: 'IMDb Episode Ratings (Vercel)',
    description: 'Adds IMDb ratings to individual episodes on series pages. Hosted on Vercel.',
    resources: ['meta'],
    types: ['series'],
    idPrefixes: ['tt']
};

// --- CORE LOGIC (No changes in the logic itself) ---
const builder = new addonBuilder(manifest);

builder.defineMetaHandler(async ({ type, id }) => {
    if (type !== 'series') {
        return { meta: null };
    }
    console.log(`Received meta request for series ID: ${id}`);

    const cachedMeta = cache.get(id);
    if (cachedMeta) {
        console.log(`Returning cached metadata for ${id}`);
        return { meta: cachedMeta };
    }

    try {
        const seriesResponse = await axios.get(`${TMDB_BASE_URL}/tv/${id}?api_key=${TMDB_API_KEY}`);
        const seriesData = seriesResponse.data;

        // Fetch details for all seasons
        const seasonPromises = seriesData.seasons.map(s =>
            axios.get(`${TMDB_BASE_URL}/tv/${id}/season/${s.season_number}?api_key=${TMDB_API_KEY}`)
        );
        const seasonResponses = await Promise.all(seasonPromises);
        const allEpisodes = seasonResponses.flatMap(res => res.data.episodes);

        // Fetch ratings for all episodes concurrently
        const episodePromises = allEpisodes.map(episode =>
            getEpisodeRating(id, episode.season_number, episode.episode_number)
        );
        const episodesWithRatings = (await Promise.all(episodePromises)).filter(Boolean);

        // Sort the final list
        episodesWithRatings.sort((a, b) => {
            if (a.season !== b.season) return a.season - b.season;
            return a.episode - b.episode;
        });

        const meta = {
            id: id,
            type: 'series',
            name: seriesData.name,
            poster: `https://image.tmdb.org/t/p/w500${seriesData.poster_path}`,
            background: `https://image.tmdb.org/t/p/original${seriesData.backdrop_path}`,
            description: seriesData.overview,
            imdbRating: seriesData.vote_average.toString(),
            videos: episodesWithRatings
        };

        console.log(`Successfully processed ${id}. Caching result.`);
        cache.set(id, meta);

        return { meta };

    } catch (error) {
        console.error(`Error fetching metadata for ${id}:`, error.message);
        return { meta: null };
    }
});

async function getEpisodeRating(seriesImdbId, seasonNumber, episodeNumber) {
    const episodeCacheKey = `${seriesImdbId}:${seasonNumber}:${episodeNumber}`;
    const cachedEpisode = cache.get(episodeCacheKey);
    if (cachedEpisode) return cachedEpisode;

    try {
        const [tmdbEpisodeResponse, omdbResponse] = await Promise.all([
            axios.get(`${TMDB_BASE_URL}/tv/${seriesImdbId}/season/${seasonNumber}/episode/${episodeNumber}?api_key=${TMDB_API_KEY}`),
            axios.get(`http://www.omdbapi.com/?i=${seriesImdbId}&Season=${seasonNumber}&Episode=${episodeNumber}&apikey=${OMDB_API_KEY}`)
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
        // console.error(`Could not fetch S${seasonNumber}E${episodeNumber} of ${seriesImdbId}: ${error.message}`);
        return null;
    }
}


// --- VERCL ADAPTER ---
// This is the crucial part for Vercel. We export a function that takes
// the request and response objects.
let handler;
module.exports = async (req, res) => {
    if (!handler) {
        const addonInterface = builder.getInterface();
        // The 'stremio-addon-sdk' doesn't have a direct middleware export for serverless,
        // so we create a simple handler based on the serveHTTP logic.
        // This is a common pattern for adapting Node.js servers to serverless.
        const { get } = require('stremio-addon-sdk/src/middleware');
        handler = get(addonInterface);
    }
    await handler(req, res);
};
