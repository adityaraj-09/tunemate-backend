const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

/**
 * Playlist Model
 * Handles database operations for playlists using a junction table approach
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
    // Start a database transaction
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // 1. Create the playlist record
      const playlistId = uuidv4();
      const playlistQuery = `
        INSERT INTO playlists (
          playlist_id, name, description, image_url, created_by
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING 
          playlist_id, name, description, image_url, 
          created_by, created_at, updated_at
      `;
      
      const playlistValues = [
        playlistId, 
        name, 
        description, 
        imageUrl, 
        userId
      ];
      
      const playlistResult = await client.query(playlistQuery, playlistValues);
      
      // 2. Add songs to the playlist if provided
      if (songIds.length > 0) {
        // Create a batch insert for all songs with positions
        const songValues = [];
        const songPlaceholders = [];
        let paramIndex = 1;
        
        songIds.forEach((songId, index) => {
          songPlaceholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2})`);
          songValues.push(playlistId, songId, index + 1); // position starts from 1
          paramIndex += 3;
        });
        
        const songQuery = `
          INSERT INTO playlist_songs (playlist_id, song_id, position)
          VALUES ${songPlaceholders.join(', ')}
        `;
        
        await client.query(songQuery, songValues);
      }
      
      // Commit the transaction
      await client.query('COMMIT');
      
      // Get the full playlist data with songs
      return await this.getPlaylistById(playlistId);
      
    } catch (error) {
      // Rollback in case of error
      await client.query('ROLLBACK');
      throw error;
    } finally {
      // Release the client back to the pool
      client.release();
    }
  }
  
  /**
   * Get playlist by ID
   * 
   * @param {string} playlistId - Playlist ID
   * @returns {Promise<Object|null>} Playlist object or null if not found
   */
  static async getPlaylistById(playlistId) {
    // 1. Get playlist details
    const playlistQuery = `
      SELECT 
        p.playlist_id, p.name, p.description, p.image_url,
        p.created_by, p.created_at, p.updated_at,
        u.username, u.first_name, u.last_name, u.profile_picture_url
      FROM 
        playlists p
      JOIN 
        users u ON p.created_by = u.user_id
      WHERE 
        p.playlist_id = $1
    `;
    
    const playlistResult = await db.query(playlistQuery, [playlistId]);
    
    if (playlistResult.rows.length === 0) {
      return null;
    }
    
    // 2. Get songs in the playlist with their positions
    const songsQuery = `
      SELECT 
        song_id, position, added_at
      FROM 
        playlist_songs
      WHERE 
        playlist_id = $1
      ORDER BY 
        position ASC
    `;
    
    const songsResult = await db.query(songsQuery, [playlistId]);
    
    // Format the response
    const playlistData = playlistResult.rows[0];
    const songs = songsResult.rows.map(row => row.song_id);
    
    return this.formatPlaylistWithCreator({
      ...playlistData,
      songs: songs,
      song_count: songs.length
    });
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
        p.playlist_id, p.name, p.description, p.image_url, 
        p.created_by, p.created_at, p.updated_at,
        (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.playlist_id) as song_count
      FROM 
        playlists p
      WHERE 
        p.created_by = $1
      ORDER BY 
        p.updated_at DESC
    `;
    
    const result = await db.query(query, [userId]);
    
    return result.rows.map(row => ({
      id: row.playlist_id,
      name: row.name,
      description: row.description,
      imageUrl: row.image_url,
      songCount: parseInt(row.song_count) || 0,
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
        playlist_id, name, description, image_url, 
        created_by, created_at, updated_at
    `;
    
    const result = await db.query(query, values);
    
    if (result.rows.length === 0) {
      throw new Error('Failed to update playlist');
    }
    
    return await this.getPlaylistById(playlistId);
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
    
    // No need to delete from playlist_songs due to ON DELETE CASCADE
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
      'SELECT created_by FROM playlists WHERE playlist_id = $1',
      [playlistId]
    );
    
    if (ownershipCheck.rows.length === 0) {
      throw new Error('Playlist not found');
    }
    
    if (ownershipCheck.rows[0].created_by !== userId) {
      throw new Error('Unauthorized: You do not own this playlist');
    }
    
    // Check if song already exists in playlist
    const songCheck = await db.query(
      'SELECT 1 FROM playlist_songs WHERE playlist_id = $1 AND song_id = $2',
      [playlistId, songId]
    );
    
    if (songCheck.rows.length > 0) {
      // Song already in playlist, no need to add
      return await this.getPlaylistById(playlistId);
    }
    
    // Get the highest position in the playlist
    const positionQuery = `
      SELECT COALESCE(MAX(position), 0) as max_position
      FROM playlist_songs 
      WHERE playlist_id = $1
    `;
    
    const positionResult = await db.query(positionQuery, [playlistId]);
    const nextPosition = parseInt(positionResult.rows[0].max_position) + 1;
    
    // Add the song to the playlist
    const query = `
      INSERT INTO playlist_songs (playlist_id, song_id, position)
      VALUES ($1, $2, $3)
    `;
    
    await db.query(query, [playlistId, songId, nextPosition]);
    
    // Update the playlist's updated_at timestamp
    await db.query(
      'UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE playlist_id = $1',
      [playlistId]
    );
    
    return await this.getPlaylistById(playlistId);
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
    
    // Start a transaction to handle position updates
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // Get the position of the song to be removed
      const positionQuery = `
        SELECT position FROM playlist_songs 
        WHERE playlist_id = $1 AND song_id = $2
      `;
      
      const positionResult = await client.query(positionQuery, [playlistId, songId]);
      
      if (positionResult.rows.length === 0) {
        // Song not in playlist
        await client.query('ROLLBACK');
        return await this.getPlaylistById(playlistId);
      }
      
      const removedPosition = positionResult.rows[0].position;
      
      // Remove the song
      const removeQuery = `
        DELETE FROM playlist_songs
        WHERE playlist_id = $1 AND song_id = $2
      `;
      
      await client.query(removeQuery, [playlistId, songId]);
      
      // Update positions of songs that were after the removed song
      const updatePositionsQuery = `
        UPDATE playlist_songs
        SET position = position - 1
        WHERE playlist_id = $1 AND position > $2
      `;
      
      await client.query(updatePositionsQuery, [playlistId, removedPosition]);
      
      // Update the playlist's updated_at timestamp
      await client.query(
        'UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE playlist_id = $1',
        [playlistId]
      );
      
      await client.query('COMMIT');
      
      return await this.getPlaylistById(playlistId);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    'SELECT created_by FROM playlists WHERE playlist_id = $1',
    [playlistId]
  );
  
  if (ownershipCheck.rows.length === 0) {
    throw new Error('Playlist not found');
  }
  
  if (ownershipCheck.rows[0].created_by !== userId) {
    throw new Error('Unauthorized: You do not own this playlist');
  }
  
  // Get current songs in the playlist
  const currentSongsQuery = `
    SELECT song_id FROM playlist_songs 
    WHERE playlist_id = $1
    ORDER BY position
  `;
  
  const currentSongsResult = await db.query(currentSongsQuery, [playlistId]);
  const currentSongs = currentSongsResult.rows.map(row => row.song_id);
  
  // Verify that all songs in the new order exist in the current playlist
  const allSongsExist = songIds.every(songId => 
    currentSongs.some(currentSongId => currentSongId === songId)
  );
  
  const sameLength = songIds.length === currentSongs.length;
  
  if (!allSongsExist || !sameLength) {
    throw new Error('Invalid song list: must contain exactly the same songs as the current playlist');
  }
  
  // Start a transaction to handle position updates
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    // Update positions for each song
    for (let i = 0; i < songIds.length; i++) {
      const updatePositionQuery = `
        UPDATE playlist_songs
        SET position = $1
        WHERE playlist_id = $2 AND song_id = $3
      `;
      
      await client.query(updatePositionQuery, [i + 1, playlistId, songIds[i]]);
    }
    
    // Update the playlist's updated_at timestamp
    await client.query(
      'UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE playlist_id = $1',
      [playlistId]
    );
    
    await client.query('COMMIT');
    
    return await this.getPlaylistById(playlistId);
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
      p.playlist_id, p.name, p.description, p.image_url,
      p.created_by, p.created_at, p.updated_at,
      u.username, u.first_name, u.last_name, u.profile_picture_url,
      COUNT(ps.song_id) as song_count
    FROM 
      playlists p
    JOIN 
      users u ON p.created_by = u.user_id
    LEFT JOIN
      playlist_songs ps ON p.playlist_id = ps.playlist_id
    GROUP BY
      p.playlist_id, u.user_id
    HAVING
      COUNT(ps.song_id) > 0
    ORDER BY 
      COUNT(ps.song_id) DESC, p.updated_at DESC
    LIMIT $1
  `;
  
  const result = await db.query(query, [limit]);
  
  return Promise.all(result.rows.map(async row => {
    // Get songs for each playlist
    const songsQuery = `
      SELECT song_id FROM playlist_songs
      WHERE playlist_id = $1
      ORDER BY position
    `;
    
    const songsResult = await db.query(songsQuery, [row.playlist_id]);
    const songs = songsResult.rows.map(songRow => songRow.song_id);
    
    return this.formatPlaylistWithCreator({
      ...row,
      songs,
      song_count: parseInt(row.song_count)
    });
  }));
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
    songCount: parseInt(row.song_count) || (row.songs ? row.songs.length : 0),
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
    songCount: parseInt(row.song_count) || (row.songs ? row.songs.length : 0),
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
      s.song_id, s.song_name, s.album, s.primary_artists, 
      s.image_url, s.media_url, s.duration, s.release_year, 
      s.language, s.genre, s.album_url, ps.position
    FROM 
      songs s
    JOIN
      playlist_songs ps ON s.song_id = ps.song_id
    WHERE 
      ps.playlist_id = $1
    ORDER BY 
      ps.position ASC
  `;
  
  const songResult = await db.query(songQuery, [playlistId]);
  
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
    genre: song.genre,
    album_url: song.album_url,
    position: song.position
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
  
  // Get the songs in the source playlist
  const songsQuery = `
    SELECT song_id FROM playlist_songs
    WHERE playlist_id = $1
    ORDER BY position
  `;
  
  const songsResult = await db.query(songsQuery, [sourcePlaylistId]);
  const songIds = songsResult.rows.map(row => row.song_id);
  
  // Create the new playlist with the same songs
  return await this.createPlaylist(
    userId,
    copyName,
    sourcePlaylist.description,
    sourcePlaylist.imageUrl,
    songIds
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
      p.playlist_id, p.name, p.description, p.image_url,
      p.created_by, p.created_at, p.updated_at,
      u.username, u.first_name, u.last_name, u.profile_picture_url,
      COUNT(ps.song_id) as song_count
    FROM 
      playlists p
    JOIN 
      users u ON p.created_by = u.user_id
    LEFT JOIN
      playlist_songs ps ON p.playlist_id = ps.playlist_id
    WHERE 
      p.name ILIKE $1
    GROUP BY
      p.playlist_id, u.user_id
    ORDER BY 
      COUNT(ps.song_id) DESC, p.updated_at DESC
    LIMIT $2
  `;
  
  const result = await db.query(searchQuery, [`%${query}%`, limit]);
  
  return Promise.all(result.rows.map(async row => {
    // Get songs for each playlist
    const songsQuery = `
      SELECT song_id FROM playlist_songs
      WHERE playlist_id = $1
      ORDER BY position
    `;
    
    const songsResult = await db.query(songsQuery, [row.playlist_id]);
    const songs = songsResult.rows.map(songRow => songRow.song_id);
    
    return this.formatPlaylistWithCreator({
      ...row,
      songs,
      song_count: parseInt(row.song_count)
    });
  }));
}

/**
 * Get user's favorite playlists
 * 
 * @param {string} userId - User ID
 * @param {number} [limit=20] - Maximum number of playlists to retrieve
 * @returns {Promise<Array<Object>>} User's favorite playlists
 */
static async getUserFavoritePlaylists(userId, limit = 20) {
  const query = `
    SELECT 
      p.playlist_id, p.name, p.description, p.image_url,
      p.created_by, p.created_at, p.updated_at,
      u.username, u.first_name, u.last_name, u.profile_picture_url,
      COUNT(ps.song_id) as song_count,
      upf.favorited_at
    FROM 
      user_playlist_favorites upf
    JOIN 
      playlists p ON upf.playlist_id = p.playlist_id
    JOIN 
      users u ON p.created_by = u.user_id
    LEFT JOIN
      playlist_songs ps ON p.playlist_id = ps.playlist_id
    WHERE 
      upf.user_id = $1
    GROUP BY
      p.playlist_id, u.user_id, upf.favorited_at
    ORDER BY 
      upf.favorited_at DESC
    LIMIT $2
  `;
  
  const result = await db.query(query, [userId, limit]);
  
  return Promise.all(result.rows.map(async row => {
    // Get songs for each playlist
    const songsQuery = `
      SELECT song_id FROM playlist_songs
      WHERE playlist_id = $1
      ORDER BY position
    `;
    
    const songsResult = await db.query(songsQuery, [row.playlist_id]);
    const songs = songsResult.rows.map(songRow => songRow.song_id);
    
    return {
      ...this.formatPlaylistWithCreator({
        ...row,
        songs,
        song_count: parseInt(row.song_count)
      }),
      favoritedAt: row.favorited_at
    };
  }));
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
    'SELECT created_by FROM playlists WHERE playlist_id = $1',
    [playlistId]
  );
  
  if (ownershipCheck.rows.length === 0) {
    throw new Error('Playlist not found');
  }
  
  if (ownershipCheck.rows[0].created_by !== userId) {
    throw new Error('Unauthorized: You do not own this playlist');
  }
  
  // Get existing songs in the playlist
  const existingSongsQuery = `
    SELECT song_id FROM playlist_songs 
    WHERE playlist_id = $1
  `;
  
  const existingSongsResult = await db.query(existingSongsQuery, [playlistId]);
  const existingSongs = existingSongsResult.rows.map(row => row.song_id);
  
  // Filter out songs that are already in the playlist
  const newSongs = songIds.filter(songId => !existingSongs.includes(songId));
  
  if (newSongs.length === 0) {
    // No new songs to add
    return await this.getPlaylistById(playlistId);
  }
  
  // Get the highest position in the playlist
  const positionQuery = `
    SELECT COALESCE(MAX(position), 0) as max_position
    FROM playlist_songs 
    WHERE playlist_id = $1
  `;
  
  const positionResult = await db.query(positionQuery, [playlistId]);
  const nextPosition = parseInt(positionResult.rows[0].max_position) + 1;
  
  // Start a transaction for adding multiple songs
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    // Add each new song with sequential positions
    for (let i = 0; i < newSongs.length; i++) {
      const insertQuery = `
        INSERT INTO playlist_songs (playlist_id, song_id, position)
        VALUES ($1, $2, $3)
      `;
      
      await client.query(insertQuery, [playlistId, newSongs[i], nextPosition + i]);
    }
    
    // Update the playlist's updated_at timestamp
    await client.query(
      'UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE playlist_id = $1',
      [playlistId]
    );
    
    await client.query('COMMIT');
    
    return await this.getPlaylistById(playlistId);
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
  
  }
  
  module.exports = Playlist;