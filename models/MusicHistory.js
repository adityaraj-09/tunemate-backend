// models/MusicHistory.js
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

/**
 * MusicHistory Model
 * Handles database operations for user music listening history
 */
class MusicHistory {
  /**
   * Record a song listen event
   * 
   * @param {string} userId - User ID
   * @param {string} songId - Song ID
   * @param {number} [duration=0] - Listen duration in seconds
   * @returns {Promise<Object>} Updated history record
   */
  static async recordListen(userId, songId, duration = 0) {
    const query = `
      INSERT INTO user_music_history (
        history_id, user_id, song_id, play_count, last_played, created_at
      )
      VALUES (
        $1, $2, $3, 1, NOW(), NOW()
      )
      ON CONFLICT (user_id, song_id)
      DO UPDATE SET
        play_count = user_music_history.play_count + 1,
        last_played = NOW()
      RETURNING 
        history_id, user_id, song_id, play_count, last_played, is_favorite
    `;
    
    const historyId = uuidv4();
    const result = await db.query(query, [historyId, userId, songId]);
    
    // Update user music preferences based on this listen
    await this.updateMusicPreferences(userId, songId, duration);
    
    return this.formatHistory(result.rows[0]);
  }


  
  /**
   * Get user's listening history
   * 
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {number} [options.limit=50] - Maximum number of results
   * @param {number} [options.offset=0] - Result offset for pagination
   * @returns {Promise<Array<Object>>} User's listening history with song details
   */
  static async getUserHistory(userId, { limit = 50, offset = 0 } = {}) {
    const query = `
      SELECT 
        umh.history_id, umh.user_id, umh.song_id, 
        umh.play_count, umh.last_played, umh.is_favorite,
        s.song_name, s.album, s.primary_artists, s.image_url, s.media_url,s.album_url
      FROM 
        user_music_history umh
      JOIN 
        songs s ON umh.song_id = s.song_id
      WHERE 
        umh.user_id = $1
      ORDER BY 
        umh.last_played DESC
      LIMIT $2 OFFSET $3
    `;
    
    const result = await db.query(query, [userId, limit, offset]);
    
    return result.rows.map(row => ({
      ...this.formatHistory(row),
      song: {
        id: row.song_id,
        name: row.song_name,
        album: row.album,
        artists: row.primary_artists,
        imageUrl: row.image_url,
        mediaUrl: row.media_url,
        album_url: row.album_url
      }
    }));
  }
  
  /**
   * Get total count of user's listening history
   * 
   * @param {string} userId - User ID
   * @returns {Promise<number>} Total count of history entries
   */
  static async getTotalCount(userId) {
    const query = `
      SELECT COUNT(*) AS total
      FROM user_music_history
      WHERE user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    return parseInt(result.rows[0].total);
  }
  
  /**
   * Toggle favorite status for a song
   * 
   * @param {string} userId - User ID
   * @param {string} songId - Song ID
   * @param {boolean} isFavorite - Whether to mark as favorite
   * @returns {Promise<Object>} Updated history record
   */
  static async toggleFavorite(userId, songId, isFavorite) {
    const query = `
      INSERT INTO user_music_history (
        history_id, user_id, song_id, play_count, last_played, is_favorite, created_at
      )
      VALUES (
        $1, $2, $3, 0, NOW(), $4, NOW()
      )
      ON CONFLICT (user_id, song_id)
      DO UPDATE SET
        is_favorite = $4
      RETURNING 
        history_id, user_id, song_id, play_count, last_played, is_favorite
    `;
    
    const historyId = uuidv4();
    const result = await db.query(query, [historyId, userId, songId, isFavorite]);
    
    return this.formatHistory(result.rows[0]);
  }
  
  /**
   * Get favorite songs for a user
   * 
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {number} [options.limit=50] - Maximum number of results
   * @param {number} [options.offset=0] - Result offset for pagination
   * @returns {Promise<Array<Object>>} User's favorite songs with details
   */
  static async getFavorites(userId, { limit = 50, offset = 0 } = {}) {
    const query = `
      SELECT 
        umh.history_id, umh.user_id, umh.song_id, 
        umh.play_count, umh.last_played, umh.is_favorite,
        s.song_name, s.album, s.primary_artists, s.image_url, s.media_url,s.album_url
      FROM 
        user_music_history umh
      JOIN 
        songs s ON umh.song_id = s.song_id
      WHERE 
        umh.user_id = $1 AND
        umh.is_favorite = TRUE
      ORDER BY 
        umh.last_played DESC
      LIMIT $2 OFFSET $3
    `;
    
    const result = await db.query(query, [userId, limit, offset]);
    
    return result.rows.map(row => ({
      ...this.formatHistory(row),
      song: {
        id: row.song_id,
        name: row.song_name,
        album: row.album,
        artists: row.primary_artists,
        imageUrl: row.image_url,
        mediaUrl: row.media_url,
        album_url: row.album_url
      }
    }));
  }
  
  /**
   * Check if a song is in a user's history
   * 
   * @param {string} userId - User ID
   * @param {string} songId - Song ID
   * @returns {Promise<boolean>} True if song is in history
   */
  static async hasSongInHistory(userId, songId) {
    const query = `
      SELECT EXISTS(
        SELECT 1
        FROM user_music_history
        WHERE user_id = $1 AND song_id = $2
      ) AS exists
    `;
    
    const result = await db.query(query, [userId, songId]);
    return result.rows[0].exists;
  }
  
  /**
   * Get common songs between two users
   * 
   * @param {string} user1Id - First user ID
   * @param {string} user2Id - Second user ID
   * @returns {Promise<Array<Object>>} Common songs with details
   */
  static async getCommonSongs(user1Id, user2Id) {
    const query = `
      SELECT 
        s.song_id, s.song_name, s.album, s.primary_artists,
        s.image_url, s.media_url,
        u1.play_count AS user1_play_count,
        u2.play_count AS user2_play_count
      FROM 
        user_music_history u1
      JOIN 
        user_music_history u2 ON u1.song_id = u2.song_id
      JOIN 
        songs s ON u1.song_id = s.song_id
      WHERE 
        u1.user_id = $1 AND
        u2.user_id = $2
      ORDER BY
        u1.last_played DESC
    `;
    
    const result = await db.query(query, [user1Id, user2Id]);
    
    return result.rows.map(row => ({
      song: {
        id: row.song_id,
        name: row.song_name,
        album: row.album,
        artists: row.primary_artists,
        imageUrl: row.image_url,
        mediaUrl: row.media_url
      },
      user1PlayCount: parseInt(row.user1_play_count),
      user2PlayCount: parseInt(row.user2_play_count)
    }));
  }
  
  /**
   * Update music preferences based on a listen event
   * 
   * @param {string} userId - User ID
   * @param {string} songId - Song ID
   * @param {number} duration - Listen duration in seconds
   * @returns {Promise<void>}
   */
  static async updateMusicPreferences(userId, songId, duration) {
    // Get song details
    const songQuery = `
      SELECT primary_artists, genre
      FROM songs
      WHERE song_id = $1
    `;
    
    const songResult = await db.query(songQuery, [songId]);
    
    if (songResult.rows.length === 0) {
      return; // Song not found
    }
    
    const song = songResult.rows[0];
    
    // Start a transaction
    return db.transaction(async (client) => {
      // Update artist preferences
      if (song.primary_artists) {
        // Split artists string by comma
        const artists = song.primary_artists.split(',').map(artist => artist.trim());
        
        for (const artist of artists) {
          if (!artist) continue;
          
          const artistPreferenceQuery = `
            INSERT INTO user_music_preferences (
              preference_id, user_id, artist, preference_weight, created_at
            )
            VALUES (
              $1, $2, $3, $4, NOW()
            )
            ON CONFLICT (user_id, artist)
            DO UPDATE SET
              preference_weight = user_music_preferences.preference_weight + $4,
              updated_at = NOW()
          `;
          
          const preferenceId = uuidv4();
          const weight = Math.min(duration / 30, 1); // Weight based on listen duration
          
          await client.query(artistPreferenceQuery, [preferenceId, userId, artist, weight]);
        }
      }
      
      // Update genre preferences if available
      if (song.genre) {
        const genrePreferenceQuery = `
          INSERT INTO user_music_preferences (
            preference_id, user_id, genre, preference_weight, created_at
          )
          VALUES (
            $1, $2, $3, $4, NOW()
          )
          ON CONFLICT (user_id, genre)
          DO UPDATE SET
            preference_weight = user_music_preferences.preference_weight + $4,
            updated_at = NOW()
        `;
        
        const preferenceId = uuidv4();
        const weight = Math.min(duration / 30, 1); // Weight based on listen duration
        
        await client.query(genrePreferenceQuery, [preferenceId, userId, song.genre, weight]);
      }
    });
  }
  
  /**
   * Format history record for external use
   * 
   * @param {Object} history - Raw history object from database
   * @returns {Object} Formatted history object
   */
  static formatHistory(history) {
    if (!history) return null;
    
    return {
      id: history.history_id,
      userId: history.user_id,
      songId: history.song_id,
      playCount: parseInt(history.play_count),
      lastPlayed: history.last_played,
      isFavorite: history.is_favorite
    };
  }



  /**
   * Get top 20 most listened songs in the last week
   * 
   * @returns {Promise<Array<Object>>} Top songs with listen counts
   */
  static async getTopSongsLastWeek() {
    const query = `
      SELECT 
        s.song_id, s.song_name, s.album, s.primary_artists, 
        s.image_url, s.media_url,
        COUNT(*) as play_count
      FROM 
        user_music_history umh
      JOIN 
        songs s ON umh.song_id = s.song_id
      WHERE 
        umh.last_played >= NOW() - INTERVAL '7 days'
      GROUP BY 
        s.song_id, s.song_name, s.album, s.primary_artists, s.image_url, s.media_url
      ORDER BY 
        play_count DESC
      LIMIT 20
    `;
    
    const result = await db.query(query);
    
    return result.rows.map(row => ({
      song: {
        id: row.song_id,
        name: row.song_name,
        album: row.album,
        artists: row.primary_artists,
        imageUrl: row.image_url,
        mediaUrl: row.media_url
      },
      playCount: parseInt(row.play_count)
    }));
  }
}

module.exports = MusicHistory;