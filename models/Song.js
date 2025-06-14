
const db = require('../config/database');
const axios = require('axios');

/**
 * Song Model
 * Handles database operations for song entities
 */
class Song {
  /**
   * Find a song by its ID
   * 
   * @param {string} songId - Song ID to find
   * @returns {Promise<Object|null>} Song object or null if not found
   */
  static async findById(songId) {
    const query = `
      SELECT 
        song_id, song_name, album, primary_artists, singers, 
        image_url, media_url, lyrics, duration, release_year, 
        language, copyright_text, genre
      FROM songs
      WHERE song_id = $1
    `;

    const result = await db.query(query, [songId]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.formatSong(result.rows[0]);
  }

  /**
   * Create or update a song in the database
   * 
   * @param {Object} songData - Song information from Saavn API
   * @returns {Promise<Object>} Created/updated song object
   */
  static async createOrUpdate(songData) {
    const {
      id,
      song,
      album,
      primary_artists,
      singers,
      image,
      media_url,
      lyrics,
      duration,
      year,
      language,
      copyright_text,
      genre
    } = songData;

    // Insert song or update if it already exists
    const query = `
      INSERT INTO songs (
        song_id, song_name, album, primary_artists, singers, 
        image_url, media_url, lyrics, duration, release_year, 
        language, copyright_text, genre
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (song_id) 
      DO UPDATE SET
        song_name = EXCLUDED.song_name,
        album = EXCLUDED.album,
        primary_artists = EXCLUDED.primary_artists,
        singers = EXCLUDED.singers,
        image_url = EXCLUDED.image_url,
        media_url = EXCLUDED.media_url,
        lyrics = EXCLUDED.lyrics,
        duration = EXCLUDED.duration,
        release_year = EXCLUDED.release_year,
        language = EXCLUDED.language,
        copyright_text = EXCLUDED.copyright_text,
        genre = EXCLUDED.genre
      RETURNING 
        song_id, song_name, album, primary_artists, singers, 
        image_url, media_url, lyrics, duration, release_year, 
        language, copyright_text, genre
    `;

    const values = [
      id,
      song,
      album,
      primary_artists,
      singers,
      image,
      media_url,
      lyrics,
      duration,
      year,
      language,
      copyright_text,
      genre
    ];

    const result = await db.query(query, values);

    return this.formatSong(result.rows[0]);
  }

  /**
   * Get popular songs based on play count
   * 
   * @param {number} limit - Number of songs to retrieve
   * @param {Array<string>} [excludeSongIds=[]] - Song IDs to exclude
   * @returns {Promise<Array<Object>>} Array of popular song objects
   */
  static async getPopular(limit = 20, excludeSongIds = []) {
    let query = `
      SELECT 
        s.song_id, s.song_name, s.album, s.primary_artists, 
        s.image_url, s.media_url, s.duration, s.release_year, 
        s.language, s.genre,s.album_url,
        COUNT(DISTINCT umh.user_id) AS listener_count
      FROM 
        songs s
      JOIN 
        user_music_history umh ON s.song_id = umh.song_id
    `;

    // Add exclusion if needed
    const params = [];
    if (excludeSongIds.length > 0) {
      // Create the correct number of placeholders ($1, $2, etc.)
      const placeholders = excludeSongIds.map((_, i) => `$${i + 1}`).join(',');
      query += ` WHERE s.song_id NOT IN (${placeholders})`;
      params.push(...excludeSongIds);
    }

    query += `
      GROUP BY 
        s.song_id, s.song_name, s.album, s.primary_artists, 
        s.image_url, s.media_url, s.duration, s.release_year, 
        s.language, s.genre,s.album_url
      ORDER BY 
        listener_count DESC, s.song_name
      LIMIT $${params.length + 1}
    `;

    params.push(limit);

    const result = await db.query(query, params);

    return result.rows.map(row => this.formatSong(row));
  }

  /**
   * Get random songs
   * 
   * @param {number} limit - Number of songs to retrieve
   * @param {Array<string>} [excludeSongIds=[]] - Song IDs to exclude
   * @returns {Promise<Array<Object>>} Array of random song objects
   */
  static async getRandom(limit = 20, excludeSongIds = []) {
    let query = `
      SELECT 
        song_id, song_name, album, primary_artists, 
        image_url, media_url, duration, release_year, 
        language, genre
      FROM songs
    `;

    // Add exclusion if needed
    const params = [];
    if (excludeSongIds.length > 0) {
      query += ` WHERE song_id NOT IN (${excludeSongIds.map((_, i) => `${i + 1}`).join(',')})`;
      params.push(...excludeSongIds);
    }

    query += `
      ORDER BY RANDOM()
      LIMIT ${params.length + 1}
    `;

    params.push(limit);

    const result = await db.query(query, params);

    return result.rows.map(row => this.formatSong(row));
  }

  /**
   * Find similar songs based on artists and genre
   * 
   * @param {string} songId - Reference song ID
   * @param {number} limit - Number of similar songs to retrieve
   * @returns {Promise<Array<Object>>} Array of similar song objects
   */
  static async findSimilar(songId, limit = 10) {
    const query = `
    WITH song_info AS (
  SELECT
    primary_artists,
    genre,
    release_year,
    language
  FROM
    songs
  WHERE
    song_id = $1
)
SELECT
  s.song_id, s.song_name, s.album, s.primary_artists,
  s.image_url, s.media_url, s.duration, s.release_year,
  s.language, s.genre,s.album_url,
  -- Language match (highest priority)
  CASE
    WHEN s.language = si.language AND si.language IS NOT NULL THEN 12
    ELSE 0
  END +
  -- Similar era/time period (second highest priority)
  CASE
    WHEN ABS(CAST(s.release_year AS INTEGER) - CAST(si.release_year AS INTEGER)) <= 2 
      AND si.release_year IS NOT NULL AND s.release_year IS NOT NULL THEN 10
    WHEN ABS(CAST(s.release_year AS INTEGER) - CAST(si.release_year AS INTEGER)) <= 5 
      AND si.release_year IS NOT NULL AND s.release_year IS NOT NULL THEN 8
    WHEN ABS(CAST(s.release_year AS INTEGER) - CAST(si.release_year AS INTEGER)) <= 10 
      AND si.release_year IS NOT NULL AND s.release_year IS NOT NULL THEN 5
    ELSE 0
  END +
  -- Artist similarity (third priority)
  CASE
    WHEN EXISTS (
      SELECT 1 
      FROM unnest(string_to_array(si.primary_artists, ',')) AS a
      WHERE s.primary_artists ILIKE '%' || a || '%'
    ) THEN 7
    ELSE 0
  END +
  -- Genre match (lowest priority but still relevant)
  CASE
    WHEN s.genre = si.genre AND si.genre IS NOT NULL THEN 4
    ELSE 0
  END AS match_score
FROM
  songs s
CROSS JOIN song_info si
WHERE
  s.song_id != $1
  AND (
    -- Language match
    (s.language = si.language AND si.language IS NOT NULL)
    -- Era match (within 10 years)
    OR (ABS(CAST(s.release_year AS INTEGER) - CAST(si.release_year AS INTEGER)) <= 10 
        AND si.release_year IS NOT NULL 
        AND s.release_year IS NOT NULL)
    -- Artist match
    OR EXISTS (
      SELECT 1 
      FROM unnest(string_to_array(si.primary_artists, ',')) AS a
      WHERE s.primary_artists ILIKE '%' || a || '%'
    )
    -- Genre match
    OR (s.genre = si.genre AND si.genre IS NOT NULL)
  )
ORDER BY
  match_score DESC, 
  -- Secondary sort by release year proximity
  ABS(CAST(s.release_year AS INTEGER) - CAST(si.release_year AS INTEGER)) ASC,
  -- Then by language matching
  CASE WHEN s.language = si.language THEN 0 ELSE 1 END,
  s.song_name
LIMIT $2
    `;

    const result = await db.query(query, [songId, limit]);

    return result.rows.map(row => ({
      ...this.formatSong(row),
      matchScore: parseFloat(row.match_score)
    }));
  }

  /**
   * Search for songs by name, album or artist
   * 
   * @param {string} query - Search query
   * @param {number} limit - Maximum number of results
   * @returns {Promise<Array<Object>>} Array of matching song objects
   */
  static async search(query, limit = 20) {
    const searchQuery = `
      SELECT 
        song_id, song_name, album, primary_artists, singers, 
        image_url, media_url, duration, release_year, 
        language, genre, album_url, lyrics,
        similarity(song_name, $1) AS song_similarity,
        similarity(primary_artists, $1) AS artist_similarity,
        similarity(album, $1) AS album_similarity
      FROM songs
      WHERE 
        song_name % $1 OR
        album % $1 OR
        primary_artists % $1
      ORDER BY
        GREATEST(similarity(song_name, $1), similarity(primary_artists, $1), similarity(album, $1)) DESC
      LIMIT $2
    `;

    const result = await db.query(searchQuery, [query, limit]);

    return result.rows.map(row => this.formatSong(row));
}


  /**
   * Get songs by genre
   * 
   * @param {string} genre - Genre to filter by
   * @param {number} limit - Maximum number of results
   * @returns {Promise<Array<Object>>} Array of song objects
   */
  static async getByGenre(genre, limit = 20) {
    const query = `
      SELECT 
        song_id, song_name, album, primary_artists, 
        image_url, media_url, duration, release_year, 
        language, genre
      FROM songs
      WHERE genre = $1
      ORDER BY RANDOM()
      LIMIT $2
    `;

    const result = await db.query(query, [genre, limit]);

    return result.rows.map(row => this.formatSong(row));
  }

  /**
   * Format song object for external use
   * 
   * @param {Object} song - Raw song object from database
   * @returns {Object} Formatted song object
   */
  static formatSong(song) {
    if (!song) return null;

    return {
      id: song.song_id,
      name: song.song_name,
      album: song.album,
      artists: song.primary_artists,
      singers: song.singers,
      imageUrl: song.image_url,
      mediaUrl: song.media_url,
      lyrics: song.lyrics,
      duration: song.duration,
      year: song.release_year,
      language: song.language,
      copyright: song.copyright_text,
      genre: song.genre,
      album_url: song.album_url,
      listenerCount: song.listener_count ? parseInt(song.listener_count) : undefined
    };
  }

  /**
   * Fetch song data from Saavn API
   * 
   * @param {string} songId - Song ID to fetch
   * @param {string} apiBaseUrl - Saavn API base URL
   * @returns {Promise<Object>} Song data from Saavn
   */
  static async fetchFromSaavn(songId, apiBaseUrl) {
    try {
      const response = await axios.get(`${apiBaseUrl}/song/get?song_id=${songId}&lyrics=false`);

      if (!response.data) {
        throw new Error(`Failed to get data for song ${songId}`);
      }

      return response.data;
    } catch (error) {
      console.error(`Error fetching song ${songId} from Saavn:`, error);
      throw error;
    }
  }
}

module.exports = Song;// models/Song.js