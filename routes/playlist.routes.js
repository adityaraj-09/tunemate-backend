const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const Playlist = require('../models/playlist');
const { authenticateToken } = require('../middleware/auth.middleware');

/**
 * @route   POST /api/playlists
 * @desc    Create a new playlist
 * @access  Private
 */
router.post(
  '/',
  [
    check('name', 'Playlist name is required').not().isEmpty(),
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { name, description, imageUrl, songIds } = req.body;
      const userId = req.user.id;

      const playlist = await Playlist.createPlaylist(
        userId,
        name,
        description,
        imageUrl,
        songIds
      );

      res.status(201).json({
        message: 'Playlist created successfully',
        playlist
      });
    } catch (error) {
      console.error('Create playlist error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// /**
//  * @route   GET /api/playlists/:id
//  * @desc    Get a playlist by ID
//  * @access  Public
//  */
// router.get('playlist/:id', async (req, res) => {
//   try {
//     const playlist = await Playlist.getPlaylistById(req.params.id);
    
//     if (!playlist) {
//       return res.status(404).json({ error: 'Playlist not found' });
//     }
    
//     res.json(playlist);
//   } catch (error) {
//     console.error('Get playlist error:', error);
//     res.status(500).json({ error: error.message });
//   }
// });

/**
 * @route   GET /api/playlists/get/
 * @desc    Get a playlist with detailed song information
 * @access  Public
 */
router.get('/get/:id', async (req, res) => {
  try {
    const playlist = await Playlist.getPlaylistWithSongs(req.params.id);
    
    if (!playlist) {
      console.error('Playlist not found');
      return res.status(404).json({ error: 'Playlist not found' });

    }
    
    res.json(playlist);
  } catch (error) {
    console.error('Get playlist with songs error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/playlists/user/:userId
 * @desc    Get all playlists created by a user
 * @access  Public
 */
router.get('/user/', async (req, res) => {
  try {
    const userId = req.user.id;

    const playlists = await Playlist.getUserPlaylists(userId);
    res.json(playlists);
  } catch (error) {
    console.error('Get user playlists error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/playlists/popular
 * @desc    Get popular playlists
 * @access  Public
 */
router.get('/popular', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const playlists = await Playlist.getPopularPlaylists(limit);
    res.json(playlists);
  } catch (error) {
    console.error('Get popular playlists error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   PUT /api/playlists/:id
 * @desc    Update a playlist
 * @access  Private
 */
router.put(
  '/:id',
  authenticateToken,
  [
    check('name', 'Playlist name is required if provided').optional().not().isEmpty(),
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { name, description, imageUrl } = req.body;
      const playlistId = req.params.id;
      const userId = req.user.id;

      const playlist = await Playlist.updatePlaylist(
        playlistId,
        userId,
        { name, description, imageUrl }
      );

      res.json({
        message: 'Playlist updated successfully',
        playlist
      });
    } catch (error) {
      console.error('Update playlist error:', error);
      
      if (error.message.includes('Unauthorized') || error.message.includes('not own')) {
        return res.status(403).json({ error: error.message });
      }
      
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * @route   DELETE /api/playlists/:id
 * @desc    Delete a playlist
 * @access  Private
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const playlistId = req.params.id;
    const userId = req.user.id;

    const success = await Playlist.deletePlaylist(playlistId, userId);

    if (success) {
      res.json({ message: 'Playlist deleted successfully' });
    } else {
      res.status(404).json({ error: 'Playlist not found' });
    }
  } catch (error) {
    console.error('Delete playlist error:', error);
    
    if (error.message.includes('Unauthorized') || error.message.includes('not own')) {
      return res.status(403).json({ error: error.message });
    }
    
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/playlists/:id/songs
 * @desc    Add a song to a playlist
 * @access  Private
 */
router.post(
  '/:id/songs',
  authenticateToken,
  [
    check('songId', 'Song ID is required').not().isEmpty(),
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { songId } = req.body;
      const playlistId = req.params.id;
      const userId = req.user.id;

      const playlist = await Playlist.addSongToPlaylist(
        playlistId,
        userId,
        songId
      );

      res.json({
        message: 'Song added to playlist successfully',
        playlist
      });
    } catch (error) {
      console.error('Add song to playlist error:', error);
      
      if (error.message.includes('Unauthorized') || error.message.includes('not own')) {
        return res.status(403).json({ error: error.message });
      }
      
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * @route   POST /api/playlists/:id/songs/batch
 * @desc    Add multiple songs to a playlist
 * @access  Private
 */
router.post(
  '/:id/songs/batch',
  authenticateToken,
  [
    check('songIds', 'Song IDs array is required').isArray().not().isEmpty(),
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { songIds } = req.body;
      const playlistId = req.params.id;
      const userId = req.user.id;

      const playlist = await Playlist.addSongsToPlaylist(
        playlistId,
        userId,
        songIds
      );

      res.json({
        message: 'Songs added to playlist successfully',
        playlist
      });
    } catch (error) {
      console.error('Add multiple songs to playlist error:', error);
      
      if (error.message.includes('Unauthorized') || error.message.includes('not own')) {
        return res.status(403).json({ error: error.message });
      }
      
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * @route   DELETE /api/playlists/:id/songs/:songId
 * @desc    Remove a song from a playlist
 * @access  Private
 */
router.delete('/:id/songs/:songId', authenticateToken, async (req, res) => {
  try {
    const playlistId = req.params.id;
    const songId = req.params.songId;
    const userId = req.user.id;

    const playlist = await Playlist.removeSongFromPlaylist(
      playlistId,
      userId,
      songId
    );

    res.json({
      message: 'Song removed from playlist successfully',
      playlist
    });
  } catch (error) {
    console.error('Remove song from playlist error:', error);
    
    if (error.message.includes('Unauthorized') || error.message.includes('not own')) {
      return res.status(403).json({ error: error.message });
    }
    
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   PUT /api/playlists/:id/reorder
 * @desc    Reorder songs in a playlist
 * @access  Private
 */
router.put(
  '/:id/reorder',
  authenticateToken,
  [
    check('songIds', 'Song IDs array is required').isArray().not().isEmpty(),
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { songIds } = req.body;
      const playlistId = req.params.id;
      const userId = req.user.id;

      const playlist = await Playlist.reorderPlaylistSongs(
        playlistId,
        userId,
        songIds
      );

      res.json({
        message: 'Playlist songs reordered successfully',
        playlist
      });
    } catch (error) {
      console.error('Reorder playlist songs error:', error);
      
      if (error.message.includes('Unauthorized') || error.message.includes('not own')) {
        return res.status(403).json({ error: error.message });
      }
      
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      
      if (error.message.includes('Invalid song list')) {
        return res.status(400).json({ error: error.message });
      }
      
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * @route   POST /api/playlists/:id/copy
 * @desc    Copy a playlist
 * @access  Private
 */
router.post(
  '/:id/copy',
  authenticateToken,
  async (req, res) => {
    try {
      const sourcePlaylistId = req.params.id;
      const userId = req.user.id;
      const { name } = req.body;

      const playlist = await Playlist.copyPlaylist(
        sourcePlaylistId,
        userId,
        name
      );

      res.status(201).json({
        message: 'Playlist copied successfully',
        playlist
      });
    } catch (error) {
      console.error('Copy playlist error:', error);
      
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * @route   GET /api/playlists/search
 * @desc    Search for playlists
 * @access  Public
 */
router.get('/search', async (req, res) => {
  try {
    const { q, limit } = req.query;
    
    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    const playlists = await Playlist.searchPlaylists(
      q,
      limit ? parseInt(limit) : 20
    );
    
    res.json(playlists);
  } catch (error) {
    console.error('Search playlists error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/playlists/favorites
 * @desc    Get user's favorite playlists
 * @access  Private
 */
router.get('/favorites', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 20;
    
    const playlists = await Playlist.getUserFavoritePlaylists(userId, limit);
    
    res.json(playlists);
  } catch (error) {
    console.error('Get favorite playlists error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/playlists/:id/favorite
 * @desc    Add a playlist to favorites
 * @access  Private
 */
router.post('/:id/favorite', authenticateToken, async (req, res) => {
  try {
    const playlistId = req.params.id;
    const userId = req.user.id;
    
    const success = await Playlist.addToFavorites(playlistId, userId);
    
    if (success) {
      res.json({ message: 'Playlist added to favorites successfully' });
    } else {
      res.json({ message: 'Playlist was already in favorites' });
    }
  } catch (error) {
    console.error('Add to favorites error:', error);
    
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   DELETE /api/playlists/:id/favorite
 * @desc    Remove a playlist from favorites
 * @access  Private
 */
router.delete('/:id/favorite', authenticateToken, async (req, res) => {
  try {
    const playlistId = req.params.id;
    const userId = req.user.id;
    
    const success = await Playlist.removeFromFavorites(playlistId, userId);
    
    if (success) {
      res.json({ message: 'Playlist removed from favorites successfully' });
    } else {
      res.json({ message: 'Playlist was not in favorites' });
    }
  } catch (error) {
    console.error('Remove from favorites error:', error);
    res.status(500).json({ error: error.message });
  }
})

module.exports = router;


