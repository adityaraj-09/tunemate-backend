
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
        s.language, s.genre,
        COUNT(DISTINCT umh.user_id) AS listener_count
      FROM 
        songs s
      JOIN 
        user_music_history umh ON s.song_id = umh.song_id
    `;
    
    // Add exclusion if needed
    const params = [];
    if (excludeSongIds.length > 0) {
      query += ` WHERE s.song_id NOT IN (${excludeSongIds.map((_, i) => `${i + 1}`).join(',')})`;
      params.push(...excludeSongIds);
    }
    
    query += `
      GROUP BY 
        s.song_id, s.song_name, s.album, s.primary_artists, 
        s.image_url, s.media_url, s.duration, s.release_year, 
        s.language, s.genre
      ORDER BY 
        listener_count DESC, s.song_name
      LIMIT ${params.length + 1}
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
          genre
        FROM 
          songs
        WHERE 
          song_id = $1
      )
      SELECT 
        s.song_id, s.song_name, s.album, s.primary_artists, 
        s.image_url, s.media_url, s.duration, s.release_year, 
        s.language, s.genre,
        CASE 
          WHEN EXISTS (
            SELECT 1 
            FROM unnest(string_to_array(si.primary_artists, ',')) AS a
            WHERE s.primary_artists ILIKE '%' || a || '%'
          ) THEN 10
          ELSE 0
        END +
        CASE 
          WHEN s.genre = si.genre AND si.genre IS NOT NULL THEN 5
          ELSE 0
        END AS match_score
      FROM 
        songs s
      CROSS JOIN song_info si
      WHERE 
        s.song_id != $1
        AND (
          EXISTS (
            SELECT 1 
            FROM unnest(string_to_array(si.primary_artists, ',')) AS a
            WHERE s.primary_artists ILIKE '%' || a || '%'
          )
          OR 
          (s.genre = si.genre AND si.genre IS NOT NULL)
        )
      ORDER BY 
        match_score DESC, s.song_name
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
        language, genre
      FROM songs
      WHERE 
        song_name ILIKE $1 OR
        album ILIKE $1 OR
        primary_artists ILIKE $1
      ORDER BY
        CASE 
          WHEN song_name ILIKE $1 THEN 1
          WHEN primary_artists ILIKE $1 THEN 2
          WHEN album ILIKE $1 THEN 3
          ELSE 4
        END
      LIMIT $2
    `;
    
    const result = await db.query(searchQuery, [`%${query}%`, limit]);
    
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