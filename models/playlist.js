const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

/**
 * Playlist Model
 * Handles database operations for playlists
 */


class Playlist {
  /**
   * Create a new playlist
   * 
   * @param {string} userId - User ID creating the playlist
   * @param {string} name - Playlist name
   * @param {string} [description] - Playlist description (optional)
   * @param {string} [imageUrl] - Playlist image URL (optional)
   * @param {Array<string>} [songIds=[]] - Initial songs for playlist (optional)
   * @returns {Promise<Object>} Newly created playlist
   */
  static async createPlaylist(userId, name, description = null, imageUrl = null, songIds = []) {
    const playlistId = uuidv4();
    const query = `
      INSERT INTO playlists (
        playlist_id, name, description, image_url, songs, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING 
        playlist_id, name, description, image_url, songs, 
        created_by, created_at, updated_at
    `;
    
    const values = [
      playlistId, 
      name, 
      description, 
      imageUrl, 
      songIds, // Array of song IDs
      userId
    ];
    
    const result = await db.query(query, values);
    
    if (result.rows.length === 0) {
      throw new Error('Failed to create playlist');
    }
    
    return this.formatPlaylist(result.rows[0]);
  }
  
  /**
   * Get playlist by ID
   * 
   * @param {string} playlistId - Playlist ID
   * @returns {Promise<Object|null>} Playlist object or null if not found
   */
  static async getPlaylistById(playlistId) {
    const query = `
      SELECT 
        p.playlist_id, p.name, p.description, p.image_url, p.songs,
        p.created_by, p.created_at, p.updated_at,
        u.username, u.first_name, u.last_name, u.profile_picture_url
      FROM 
        playlists p
      JOIN 
        users u ON p.created_by = u.user_id
      WHERE 
        p.playlist_id = $1
    `;
    
    const result = await db.query(query, [playlistId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.formatPlaylistWithCreator(result.rows[0]);
  }
  
  /**
   * Get all playlists created by a user
   * 
   * @param {string} userId - User ID
   * @returns {Promise<Array<Object>>} User's playlists
   */
  static async getUserPlaylists(userId) {
    const query = `
      SELECT 
        playlist_id, name, description, image_url, songs, 
        created_by, created_at, updated_at,
        array_length(songs, 1) as song_count
      FROM 
        playlists
      WHERE 
        created_by = $1
      ORDER BY 
        updated_at DESC
    `;
    
    const result = await db.query(query, [userId]);
    
    return result.rows.map(row => ({
      id: row.playlist_id,
      name: row.name,
      description: row.description,
      imageUrl: row.image_url,
      songCount: row.song_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }
  
  /**
   * Update playlist details
   * 
   * @param {string} playlistId - Playlist ID
   * @param {string} userId - User ID (for authorization)
   * @param {Object} updates - Fields to update
   * @param {string} [updates.name] - Updated name
   * @param {string} [updates.description] - Updated description
   * @param {string} [updates.imageUrl] - Updated image URL
   * @returns {Promise<Object>} Updated playlist
   */
  static async updatePlaylist(playlistId, userId, { name, description, imageUrl }) {
    // First check if user owns this playlist
    const ownershipCheck = await db.query(
      'SELECT created_by FROM playlists WHERE playlist_id = $1',
      [playlistId]
    );
    
    if (ownershipCheck.rows.length === 0) {
      throw new Error('Playlist not found');
    }
    
    if (ownershipCheck.rows[0].created_by !== userId) {
      throw new Error('Unauthorized: You do not own this playlist');
    }
    
    // Build update query dynamically based on provided fields
    const updates = [];
    const values = [playlistId];
    let paramIndex = 2;
    
    if (name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      values.push(name);
      paramIndex++;
    }
    
    if (description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      values.push(description);
      paramIndex++;
    }
    
    if (imageUrl !== undefined) {
      updates.push(`image_url = $${paramIndex}`);
      values.push(imageUrl);
      paramIndex++;
    }
    
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    
    if (updates.length === 1) {
      // Only updated_at was added, no actual changes
      throw new Error('No valid fields to update');
    }
    
    const query = `
      UPDATE playlists 
      SET ${updates.join(', ')}
      WHERE playlist_id = $1
      RETURNING 
        playlist_id, name, description, image_url, songs, 
        created_by, created_at, updated_at
    `;
    
    const result = await db.query(query, values);
    
    if (result.rows.length === 0) {
      throw new Error('Failed to update playlist');
    }
    
    return this.formatPlaylist(result.rows[0]);
  }
  
  /**
   * Delete a playlist
   * 
   * @param {string} playlistId - Playlist ID
   * @param {string} userId - User ID (for authorization)
   * @returns {Promise<boolean>} True if deleted successfully
   */
  static async deletePlaylist(playlistId, userId) {
    // First check if user owns this playlist
    const ownershipCheck = await db.query(
      'SELECT created_by FROM playlists WHERE playlist_id = $1',
      [playlistId]
    );
    
    if (ownershipCheck.rows.length === 0) {
      throw new Error('Playlist not found');
    }
    
    if (ownershipCheck.rows[0].created_by !== userId) {
      throw new Error('Unauthorized: You do not own this playlist');
    }
    
    const query = `
      DELETE FROM playlists
      WHERE playlist_id = $1
    `;
    
    const result = await db.query(query, [playlistId]);
    
    return result.rowCount > 0;
  }
  
  /**
   * Add a song to a playlist
   * 
   * @param {string} playlistId - Playlist ID
   * @param {string} userId - User ID (for authorization)
   * @param {string} songId - Song ID to add
   * @returns {Promise<Object>} Updated playlist
   */
  static async addSongToPlaylist(playlistId, userId, songId) {
    // First check if user owns this playlist
    const ownershipCheck = await db.query(
      'SELECT created_by, songs FROM playlists WHERE playlist_id = $1',
      [playlistId]
    );
    
    if (ownershipCheck.rows.length === 0) {
      throw new Error('Playlist not found');
    }
    
    if (ownershipCheck.rows[0].created_by !== userId) {
      throw new Error('Unauthorized: You do not own this playlist');
    }
    
    // Check if song already exists in playlist
    const currentSongs = ownershipCheck.rows[0].songs || [];
    if (currentSongs.includes(songId)) {
      // Song already in playlist, no need to add
      return await this.getPlaylistById(playlistId);
    }
    
    const query = `
      UPDATE playlists
      SET songs = array_append(songs, $1), updated_at = CURRENT_TIMESTAMP
      WHERE playlist_id = $2
      RETURNING 
        playlist_id, name, description, image_url, songs, 
        created_by, created_at, updated_at
    `;
    
    const result = await db.query(query, [songId, playlistId]);
    
    if (result.rows.length === 0) {
      throw new Error('Failed to add song to playlist');
    }
    
    return this.formatPlaylist(result.rows[0]);
  }
  
  /**
   * Remove a song from a playlist
   * 
   * @param {string} playlistId - Playlist ID
   * @param {string} userId - User ID (for authorization)
   * @param {string} songId - Song ID to remove
   * @returns {Promise<Object>} Updated playlist
   */
  static async removeSongFromPlaylist(playlistId, userId, songId) {
    // First check if user owns this playlist
    const ownershipCheck = await db.query(
      'SELECT created_by FROM playlists WHERE playlist_id = $1',
      [playlistId]
    );
    
    if (ownershipCheck.rows.length === 0) {
      throw new Error('Playlist not found');
    }
    
    if (ownershipCheck.rows[0].created_by !== userId) {
      throw new Error('Unauthorized: You do not own this playlist');
    }
    
    const query = `
      UPDATE playlists
      SET songs = array_remove(songs, $1), updated_at = CURRENT_TIMESTAMP
      WHERE playlist_id = $2
      RETURNING 
        playlist_id, name, description, image_url, songs, 
        created_by, created_at, updated_at
    `;
    
    const result = await db.query(query, [songId, playlistId]);
    
    if (result.rows.length === 0) {
      throw new Error('Failed to remove song from playlist');
    }
    
    return this.formatPlaylist(result.rows[0]);
  }
  
  /**
   * Reorder songs in a playlist
   * 
   * @param {string} playlistId - Playlist ID
   * @param {string} userId - User ID (for authorization)
   * @param {Array<string>} songIds - New order of song IDs
   * @returns {Promise<Object>} Updated playlist
   */
  static async reorderPlaylistSongs(playlistId, userId, songIds) {
    // First check if user owns this playlist
    const ownershipCheck = await db.query(
      'SELECT created_by, songs FROM playlists WHERE playlist_id = $1',
      [playlistId]
    );
    
    if (ownershipCheck.rows.length === 0) {
      throw new Error('Playlist not found');
    }
    
    if (ownershipCheck.rows[0].created_by !== userId) {
      throw new Error('Unauthorized: You do not own this playlist');
    }
    
    // Verify that all songs in the new order exist in the current playlist
    const currentSongs = ownershipCheck.rows[0].songs || [];
    const allSongsExist = songIds.every(songId => currentSongs.includes(songId));
    const sameLength = songIds.length === currentSongs.length;
    
    if (!allSongsExist || !sameLength) {
      throw new Error('Invalid song list: must contain exactly the same songs as the current playlist');
    }
    
    const query = `
      UPDATE playlists
      SET songs = $1, updated_at = CURRENT_TIMESTAMP
      WHERE playlist_id = $2
      RETURNING 
        playlist_id, name, description, image_url, songs, 
        created_by, created_at, updated_at
    `;
    
    const result = await db.query(query, [songIds, playlistId]);
    
    if (result.rows.length === 0) {
      throw new Error('Failed to reorder playlist songs');
    }
    
    return this.formatPlaylist(result.rows[0]);
  }
  
  /**
   * Get popular/trending playlists
   *
   * @param {number} [limit=10] - Maximum number of playlists to retrieve
   * @returns {Promise<Array<Object>>} Popular playlists
   */
  static async getPopularPlaylists(limit = 10) {
    // This is a simplified implementation - in a real system, you might calculate
    // popularity based on play counts, follows, etc.
    const query = `
      SELECT 
        p.playlist_id, p.name, p.description, p.image_url, p.songs,
        p.created_by, p.created_at, p.updated_at,
        u.username, u.first_name, u.last_name, u.profile_picture_url,
        array_length(p.songs, 1) as song_count
      FROM 
        playlists p
      JOIN 
        users u ON p.created_by = u.user_id
      WHERE 
        array_length(p.songs, 1) > 0
      ORDER BY 
        array_length(p.songs, 1) DESC, p.updated_at DESC
      LIMIT $1
    `;
    
    const result = await db.query(query, [limit]);
    
    return result.rows.map(row => this.formatPlaylistWithCreator(row));
  }
  
  /**
   * Format playlist data for API response
   * 
   * @param {Object} row - Database row
   * @returns {Object} Formatted playlist
   */
  static formatPlaylist(row) {
    return {
      id: row.playlist_id,
      name: row.name,
      description: row.description,
      imageUrl: row.image_url,
      songs: row.songs || [],
      songCount: row.song_count || (row.songs ? row.songs.length : 0),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
  
  /**
   * Format playlist with creator info for API response
   * 
   * @param {Object} row - Database row with creator info
   * @returns {Object} Formatted playlist with creator
   */
  static formatPlaylistWithCreator(row) {
    return {
      id: row.playlist_id,
      name: row.name,
      description: row.description,
      imageUrl: row.image_url,
      songs: row.songs || [],
      songCount: row.song_count || (row.songs ? row.songs.length : 0),
      creator: {
        id: row.created_by,
        username: row.username,
        firstName: row.first_name,
        lastName: row.last_name,
        profilePicture: row.profile_picture_url
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
  
/**
 * Get detailed playlist info with song details
 * 
 * @param {string} playlistId - Playlist ID
 * @returns {Promise<Object>} Playlist with detailed song info
 */
static async getPlaylistWithSongs(playlistId) {
    // First get the playlist
    const playlist = await this.getPlaylistById(playlistId);
    
    if (!playlist) {
      return null;
    }
    
    // If there are no songs, return the playlist as is
    if (!playlist.songs || playlist.songs.length === 0) {
      return {
        ...playlist,
        songs: []
      };
    }
    
    // Get detailed info for each song
    const songQuery = `
      SELECT 
        song_id, song_name, album, primary_artists, 
        image_url, media_url, duration, release_year, 
        language, genre
      FROM 
        songs
      WHERE 
        song_id = ANY($1)
      ORDER BY 
        array_position($1, song_id)
    `;
    
    const songResult = await db.query(songQuery, [playlist.songs]);
    
    // Format each song
    const formattedSongs = songResult.rows.map(song => ({
      id: song.song_id,
      name: song.song_name,
      album: song.album,
      artists: song.primary_artists,
      imageUrl: song.image_url,
      mediaUrl: song.media_url,
      duration: song.duration,
      releaseYear: song.release_year,
      language: song.language,
      genre: song.genre
    }));
    
    // Return playlist with detailed song info
    return {
      ...playlist,
      songs: formattedSongs
    };
  }
  
  /**
   * Create a copy of a playlist
   * 
   * @param {string} sourcePlaylistId - Source playlist ID to copy
   * @param {string} userId - User ID creating the copy
   * @param {string} [newName] - Optional new name for the copy (defaults to "Copy of [original name]")
   * @returns {Promise<Object>} Newly created playlist copy
   */
  static async copyPlaylist(sourcePlaylistId, userId, newName = null) {
    // Get the source playlist
    const sourcePlaylist = await this.getPlaylistById(sourcePlaylistId);
    
    if (!sourcePlaylist) {
      throw new Error('Source playlist not found');
    }
    
    // Create a name for the copy if not provided
    const copyName = newName || `Copy of ${sourcePlaylist.name}`;
    
    // Create the new playlist with the same songs
    return await this.createPlaylist(
      userId,
      copyName,
      sourcePlaylist.description,
      sourcePlaylist.imageUrl,
      sourcePlaylist.songs
    );
  }
  
  /**
   * Search for playlists by name
   * 
   * @param {string} query - Search query
   * @param {number} [limit=20] - Maximum number of results
   * @returns {Promise<Array<Object>>} Matching playlists
   */
  static async searchPlaylists(query, limit = 20) {
    const searchQuery = `
      SELECT 
        p.playlist_id, p.name, p.description, p.image_url, p.songs,
        p.created_by, p.created_at, p.updated_at,
        u.username, u.first_name, u.last_name, u.profile_picture_url,
        array_length(p.songs, 1) as song_count
      FROM 
        playlists p
      JOIN 
        users u ON p.created_by = u.user_id
      WHERE 
        p.name ILIKE $1
      ORDER BY 
        array_length(p.songs, 1) DESC, p.updated_at DESC
      LIMIT $2
    `;
    
    const result = await db.query(searchQuery, [`%${query}%`, limit]);
    
    return result.rows.map(row => this.formatPlaylistWithCreator(row));
  }
  
  /**
   * Get user's favorite playlists
   * 
   * @param {string} userId - User ID
   * @param {number} [limit=20] - Maximum number of playlists to retrieve
   * @returns {Promise<Array<Object>>} User's favorite playlists
   */
  static async getUserFavoritePlaylists(userId, limit = 20) {
    // Note: This assumes you have a user_playlist_favorites table
    // If you don't, you'll need to create one
    const query = `
      SELECT 
        p.playlist_id, p.name, p.description, p.image_url, p.songs,
        p.created_by, p.created_at, p.updated_at,
        u.username, u.first_name, u.last_name, u.profile_picture_url,
        array_length(p.songs, 1) as song_count,
        upf.favorited_at
      FROM 
        user_playlist_favorites upf
      JOIN 
        playlists p ON upf.playlist_id = p.playlist_id
      JOIN 
        users u ON p.created_by = u.user_id
      WHERE 
        upf.user_id = $1
      ORDER BY 
        upf.favorited_at DESC
      LIMIT $2
    `;
    
    const result = await db.query(query, [userId, limit]);
    
    return result.rows.map(row => ({
      ...this.formatPlaylistWithCreator(row),
      favoritedAt: row.favorited_at
    }));
  }
  
  /**
   * Add a playlist to user's favorites
   * 
   * @param {string} playlistId - Playlist ID to favorite
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if successfully added
   */
  static async addToFavorites(playlistId, userId) {
    // Check if playlist exists
    const playlistCheck = await db.query(
      'SELECT playlist_id FROM playlists WHERE playlist_id = $1',
      [playlistId]
    );
    
    if (playlistCheck.rows.length === 0) {
      throw new Error('Playlist not found');
    }
    
    // Insert favorite (or ignore if already exists)
    const query = `
      INSERT INTO user_playlist_favorites (user_id, playlist_id, favorited_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, playlist_id) DO NOTHING
      RETURNING user_id
    `;
    
    const result = await db.query(query, [userId, playlistId]);
    
    return result.rowCount > 0;
  }
  
  /**
   * Remove a playlist from user's favorites
   * 
   * @param {string} playlistId - Playlist ID to unfavorite
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if successfully removed
   */
  static async removeFromFavorites(playlistId, userId) {
    const query = `
      DELETE FROM user_playlist_favorites
      WHERE user_id = $1 AND playlist_id = $2
    `;
    
    const result = await db.query(query, [userId, playlistId]);
    
    return result.rowCount > 0;
  }
  
  /**
   * Check if a user has favorited a playlist
   * 
   * @param {string} playlistId - Playlist ID
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if the playlist is in user's favorites
   */
  static async isFavorite(playlistId, userId) {
    const query = `
      SELECT EXISTS (
        SELECT 1 FROM user_playlist_favorites
        WHERE user_id = $1 AND playlist_id = $2
      ) AS is_favorite
    `;
    
    const result = await db.query(query, [userId, playlistId]);
    
    return result.rows[0].is_favorite;
  }
  
  /**
   * Add multiple songs to a playlist
   * 
   * @param {string} playlistId - Playlist ID
   * @param {string} userId - User ID (for authorization)
   * @param {Array<string>} songIds - Array of song IDs to add
   * @returns {Promise<Object>} Updated playlist
   */
  static async addSongsToPlaylist(playlistId, userId, songIds) {
    // First check if user owns this playlist
    const ownershipCheck = await db.query(
      'SELECT created_by, songs FROM playlists WHERE playlist_id = $1',
      [playlistId]
    );
    
    if (ownershipCheck.rows.length === 0) {
      throw new Error('Playlist not found');
    }
    
    if (ownershipCheck.rows[0].created_by !== userId) {
      throw new Error('Unauthorized: You do not own this playlist');
    }
    
    // Filter out songs that are already in the playlist
    const currentSongs = ownershipCheck.rows[0].songs || [];
    const newSongs = songIds.filter(songId => !currentSongs.includes(songId));
    
    if (newSongs.length === 0) {
      // No new songs to add
      return await this.getPlaylistById(playlistId);
    }
    
    // Add new songs to the playlist
    const query = `
      UPDATE playlists
      SET songs = songs || $1, updated_at = CURRENT_TIMESTAMP
      WHERE playlist_id = $2
      RETURNING 
        playlist_id, name, description, image_url, songs, 
        created_by, created_at, updated_at
    `;
    
    const result = await db.query(query, [newSongs, playlistId]);
    
    if (result.rows.length === 0) {
      throw new Error('Failed to add songs to playlist');
    }
    
    return this.formatPlaylist(result.rows[0]);
  }
  
  }
  
  module.exports = Playlist;