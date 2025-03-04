// models/MusicPreference.js
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

/**
 * MusicPreference Model
 * Handles database operations for user music preferences
 */
class MusicPreference {
  /**
   * Get user's music preferences
   * 
   * @param {string} userId - User ID
   * @returns {Promise<Object>} User's music preferences (genres and artists)
   */
  static async getPreferences(userId) {
    const query = `
      SELECT 
        genre, 
        artist, 
        preference_weight
      FROM 
        user_music_preferences
      WHERE 
        user_id = $1
      ORDER BY 
        preference_weight DESC
    `;
    
    const result = await db.query(query, [userId]);
    
    // Organize into genres and artists
    const genres = [];
    const artists = [];
    
    result.rows.forEach(row => {
      if (row.genre) {
        genres.push({
          name: row.genre,
          weight: parseFloat(row.preference_weight)
        });
      }
      
      if (row.artist) {
        artists.push({
          name: row.artist,
          weight: parseFloat(row.preference_weight)
        });
      }
    });
    
    return {
      genres,
      artists
    };
  }
  
  /**
   * Update user's music preferences
   * 
   * @param {string} userId - User ID
   * @param {Object} preferences - Music preferences data
   * @param {Array<string>} [preferences.genres=[]] - Preferred music genres
   * @param {Array<string>} [preferences.artists=[]] - Preferred music artists
   * @returns {Promise<void>}
   */
  static async updatePreferences(userId, { genres = [], artists = [] }) {
    // Start a transaction
    return db.transaction(async (client) => {
      // Store genre preferences
      for (const genre of genres) {
        if (!genre) continue;
        
        const genreQuery = `
          INSERT INTO user_music_preferences (
            preference_id, user_id, genre, preference_weight, created_at
          )
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (user_id, genre)
          DO UPDATE SET
            preference_weight = GREATEST(user_music_preferences.preference_weight, $4),
            updated_at = NOW()
        `;
        
        const preferenceId = uuidv4();
        // Higher weight (5) for explicitly selected genres
        await client.query(genreQuery, [preferenceId, userId, genre, 5]);
      }
      
      // Store artist preferences
      for (const artist of artists) {
        if (!artist) continue;
        
        const artistQuery = `
          INSERT INTO user_music_preferences (
            preference_id, user_id, artist, preference_weight, created_at
          )
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (user_id, artist)
          DO UPDATE SET
            preference_weight = GREATEST(user_music_preferences.preference_weight, $4),
            updated_at = NOW()
        `;
        
        const preferenceId = uuidv4();
        // Higher weight (5) for explicitly selected artists
        await client.query(artistQuery, [preferenceId, userId, artist, 5]);
      }
    });
  }
  
  /**
   * Increment preference weight for a genre
   * 
   * @param {string} userId - User ID
   * @param {string} genre - Genre name
   * @param {number} [weight=1] - Weight to add
   * @returns {Promise<Object>} Updated genre preference
   */
  static async incrementGenreWeight(userId, genre, weight = 1) {
    if (!genre) return null;
    
    const query = `
      INSERT INTO user_music_preferences (
        preference_id, user_id, genre, preference_weight, created_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, genre)
      DO UPDATE SET
        preference_weight = user_music_preferences.preference_weight + $4,
        updated_at = NOW()
      RETURNING preference_id, user_id, genre, preference_weight, created_at, updated_at
    `;
    
    const preferenceId = uuidv4();
    const result = await db.query(query, [preferenceId, userId, genre, weight]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return {
      id: result.rows[0].preference_id,
      userId: result.rows[0].user_id,
      genre: result.rows[0].genre,
      weight: parseFloat(result.rows[0].preference_weight),
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].updated_at
    };
  }
  
  /**
   * Increment preference weight for an artist
   * 
   * @param {string} userId - User ID
   * @param {string} artist - Artist name
   * @param {number} [weight=1] - Weight to add
   * @returns {Promise<Object>} Updated artist preference
   */
  static async incrementArtistWeight(userId, artist, weight = 1) {
    if (!artist) return null;
    
    const query = `
      INSERT INTO user_music_preferences (
        preference_id, user_id, artist, preference_weight, created_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, artist)
      DO UPDATE SET
        preference_weight = user_music_preferences.preference_weight + $4,
        updated_at = NOW()
      RETURNING preference_id, user_id, artist, preference_weight, created_at, updated_at
    `;
    
    const preferenceId = uuidv4();
    const result = await db.query(query, [preferenceId, userId, artist, weight]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return {
      id: result.rows[0].preference_id,
      userId: result.rows[0].user_id,
      artist: result.rows[0].artist,
      weight: parseFloat(result.rows[0].preference_weight),
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].updated_at
    };
  }
  
  /**
   * Get top genres for a user
   * 
   * @param {string} userId - User ID
   * @param {number} [limit=10] - Maximum number of genres to retrieve
   * @returns {Promise<Array<Object>>} Top genres with weights
   */
  static async getTopGenres(userId, limit = 10) {
    const query = `
      SELECT 
        genre, 
        preference_weight
      FROM 
        user_music_preferences
      WHERE 
        user_id = $1 AND
        genre IS NOT NULL
      ORDER BY 
        preference_weight DESC
      LIMIT $2
    `;
    
    const result = await db.query(query, [userId, limit]);
    
    return result.rows.map(row => ({
      name: row.genre,
      weight: parseFloat(row.preference_weight)
    }));
  }
  
  /**
   * Get top artists for a user
   * 
   * @param {string} userId - User ID
   * @param {number} [limit=10] - Maximum number of artists to retrieve
   * @returns {Promise<Array<Object>>} Top artists with weights
   */
  static async getTopArtists(userId, limit = 10) {
    const query = `
      SELECT 
        artist, 
        preference_weight
      FROM 
        user_music_preferences
      WHERE 
        user_id = $1 AND
        artist IS NOT NULL
      ORDER BY 
        preference_weight DESC
      LIMIT $2
    `;
    
    const result = await db.query(query, [userId, limit]);
    
    return result.rows.map(row => ({
      name: row.artist,
      weight: parseFloat(row.preference_weight)
    }));
  }
  
  /**
   * Delete all preferences for a user
   * 
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if preferences were deleted
   */
  static async deleteAll(userId) {
    const query = `
      DELETE FROM user_music_preferences
      WHERE user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    
    return result.rowCount > 0;
  }
  
  /**
   * Find users with similar music taste
   * 
   * @param {string} userId - User ID
   * @param {number} [limit=20] - Maximum number of users to retrieve
   * @returns {Promise<Array<Object>>} Users with similar taste and similarity score
   */
  static async findSimilarUsers(userId, limit = 20) {
    // This complex query calculates similarity based on shared genres and artists
    const query = `
      WITH user_preferences AS (
        SELECT 
          genre,
          artist,
          preference_weight
        FROM 
          user_music_preferences
        WHERE 
          user_id = $1
      ),
      other_users AS (
        SELECT DISTINCT 
          ump.user_id
        FROM 
          user_music_preferences ump
        WHERE 
          ump.user_id != $1
      ),
      genre_similarity AS (
        SELECT 
          ou.user_id,
          SUM(
            CASE 
              WHEN up.genre IS NOT NULL AND up.genre = ump.genre 
              THEN LEAST(up.preference_weight, ump.preference_weight)
              ELSE 0
            END
          ) as genre_score
        FROM 
          other_users ou
        CROSS JOIN 
          user_preferences up
        LEFT JOIN 
          user_music_preferences ump 
          ON ou.user_id = ump.user_id AND up.genre = ump.genre
        GROUP BY 
          ou.user_id
      ),
      artist_similarity AS (
        SELECT 
          ou.user_id,
          SUM(
            CASE 
              WHEN up.artist IS NOT NULL AND up.artist = ump.artist 
              THEN LEAST(up.preference_weight, ump.preference_weight)
              ELSE 0
            END
          ) as artist_score
        FROM 
          other_users ou
        CROSS JOIN 
          user_preferences up
        LEFT JOIN 
          user_music_preferences ump 
          ON ou.user_id = ump.user_id AND up.artist = ump.artist
        GROUP BY 
          ou.user_id
      )
      SELECT 
        u.user_id,
        u.username,
        u.first_name,
        u.last_name,
        u.profile_picture_url,
        COALESCE(gs.genre_score, 0) * 0.4 + COALESCE(as.artist_score, 0) * 0.6 as similarity_score
      FROM 
        genre_similarity gs
      JOIN 
        artist_similarity as ON gs.user_id = as.user_id
      JOIN 
        users u ON gs.user_id = u.user_id
      WHERE 
        COALESCE(gs.genre_score, 0) > 0 OR COALESCE(as.artist_score, 0) > 0
      ORDER BY 
        similarity_score DESC
      LIMIT $2
    `;
    
    const result = await db.query(query, [userId, limit]);
    
    return result.rows.map(row => ({
      userId: row.user_id,
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      profilePicture: row.profile_picture_url,
      similarityScore: parseFloat(row.similarity_score)
    }));
  }
}

module.exports = MusicPreference;