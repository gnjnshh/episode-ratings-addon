const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');

// This addon will get API keys from Vercel's Environment Variables.
const { TMDB_API_KEY, OMDB_API_KEY } = process.env;

// Check if the keys are set on the server.
if (!TMDB_API_KEY || !OMDB_API_KEY) {
    // This message will appear in Vercel logs if the keys are missing.
    console.error("FATAL: API keys are not set in Vercel Environment Variables.");
}

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const cache = new NodeCache({ stdTTL: 24 * 60 * 60 });

// --- Simplified Manifest ---
const manifest = {
    id: 'community.imdb.episode.ratings.simple',
    version: '1.0.0',
    name: 'IMDb Episode Ratings',
    description: 'A simple addon that automatically adds IMDb ratings to episodes.',
    resources: ['meta'],
    types: ['series'],
    idPrefixes: ['tt'],
    catalogs: []
};

// --- CORE LOGIC ---
const builder = new addonBuilder(manifest);

builder.defineMetaHandler(async (args) => {
    // No more checking for user config. We use the server's keys directly.
    const { type, id } = args;

    if (type !== 'series') { return { meta: null }; }

    const cachedMeta = cache.get(id);
    if (cachedMeta) { return { meta: cachedMeta }; }

    try {
        const seriesResponse = await axios.get(`${TMDB_BASE_URL}/tv/${id}?api_key=${TMDB_API_KEY}`);
        const seriesData = seriesResponse.data;

        const seasonPromises = seriesData.seasons.map(s =>
            axios.get(`${TMDB_BASE_URL}/tv/${id}/season/${s.season_number}?api_key=${TMDB_API_KEY}`)
        );
        const seasonResponses = await Promise.all(seasonPromises);
        const allEpisodes = seasonResponses.flatMap(res => res.data.episodes);

        const episodePromises = allEpisodes.map(episode =>
            getEpisodeRating(id, episode.season_number, episode.episode_number)
        );
        const episodesWithRatings = (await Promise.all(episodePromises)).filter(Boolean);

        episodesWithRatings.sort((a, b) => {
            if (a.season !== b.season) return a.season - b.season;
            return a.episode - b.episode;
        });

        const meta = {
            id: id, type: 'series', name: seriesData.name,
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
        return Promise.reject(`Failed to fetch metadata for ${id}.`);
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

        if (omdbEpisode.Response === "False") { throw new Error(omdbEpisode.Error); }

        const episodeObject = {
            id: `${seriesImdbId}:${seasonNumber}:${episodeNumber}`,
            title: tmdbEpisode.name || `Episode ${episodeNumber}`,
            season: seasonNumber, episode: episodeNumber, overview: tmdbEpisode.overview,
            thumbnail: tmdbEpisode.still_path ? `https://image.tmdb.org/t/p/w300${tmdbEpisode.still_path}` : null,
            released: new Date(tmdbEpisode.air_date),
            imdbRating: omdbEpisode.imdbRating && omdbEpisode.imdbRating !== 'N/A' ? omdbEpisode.imdbRating : null
        };

        cache.set(episodeCacheKey, episodeObject, 12 * 60 * 60);
        return episodeObject;

    } catch (error) { return null; }
}

// --- VERCL ADAPTER (Simplified) ---
const { getRouter } = require("stremio-addon-sdk");
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

module.exports = (req, res) => {
    // No more /configure route needed.
    // The manifest routing fix is no longer needed because the install link is simple.
    router(req, res, () => {
        res.statusCode = 404;
        res.end();
    });
};
