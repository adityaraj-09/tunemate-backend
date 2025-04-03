// routes/song.routes.js
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const Song = require('../models/Song');
const MusicHistory = require('../models/MusicHistory');
const { listenQueue, songDataQueue } = require('../config/queue');
const { publish, CHANNELS } = require('../config/redis');
const axios = require('axios');
require('dotenv').config();
/**
 * @route   GET /api/songs/:songId
 * @desc    Get song details
 * @access  Public
 */
router.get('get/:songId', async (req, res) => {
  try {
    const songId = req.params.songId;

    console.log('Fetching song:', songId);

    
    // Get song from database
    let song = await Song.findById(songId);
    
    // If song not found in our database, try to fetch from Saavn
    if (!song) {
      try {
        const MUSIC_API_URL = process.env.MUSIC_API_URL || 'http://localhost:8000';
        const songData = await Song.fetchFromSaavn(songId, MUSIC_API_URL);
        
        // Store song in our database
        song = await Song.createOrUpdate(songData);
      } catch (error) {
        console.error('Error fetching song from Saavn:', error);
        return res.status(404).json({ error: 'Song not found' });
      }
    }
    
    res.json({ song });
  } catch (error) {
    console.error('Error fetching song:', error);
    res.status(500).json({ error: 'Server error fetching song' });
  }
});

/**
 * @route   GET /api/songs/popular
 * @desc    Get popular songs
 * @access  Public
 */
router.get('/popular', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    
    // Get popular songs
    const songs = await Song.getPopular(limit);
    
    res.json({ songs });
  } catch (error) {
    console.error('Error fetching popular songs:', error);
    res.status(500).json({ error: 'Server error fetching popular songs' });
  }
});

/**
 * @route   GET /api/songs/similar/:songId
 * @desc    Get similar songs
 * @access  Public
 */
router.get('/similar/:songId', async (req, res) => {
  try {
    const songId = req.params.songId;
    const limit = parseInt(req.query.limit) || 10;
    
    // Get similar songs
    const similarSongs = await Song.findSimilar(songId, limit);
    
    res.json({ similarSongs });
  } catch (error) {
    console.error('Error fetching similar songs:', error);
    res.status(500).json({ error: 'Server error fetching similar songs' });
  }
});

/**
 * @route   POST /api/songs/listen
 * @desc    Record song listen
 * @access  Private
 */
router.post(
  '/listen',
  [
    check('song', 'song').not().isEmpty(),
    check('duration', 'Duration must be a number').optional().isNumeric()
  ],
  async (req, res) => {
    // Check if user is authenticated
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { song, duration = 0 } = req.body;
      
      // Add listen event to queue for processing
      await listenQueue.add(
        'process-listen',
        { userId: req.user.id, song, duration },
        { 
          removeOnComplete: true,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000
          }
        }
      );
      
      // // Publish event for real-time subscribers
      // await publish(CHANNELS.SONG_LISTEN, {
      //   userId: req.user.id,
      //   songId,
      //   timestamp: new Date().toISOString()
      // });
      
      // // Record the listen synchronously if needed for immediate feedback
      // await MusicHistory.recordListen(req.user.id, songId, duration);
      
      res.json({ success: true, message: 'Listen event recorded' });
    } catch (error) {
      console.error('Error recording listen:', error);
      res.status(500).json({ error: 'Server error recording listen' });
    }
  }
);

/**
 * @route   GET /api/songs/search
 * @desc    Search for songs
 * @access  Public
 */
router.get('/search', async (req, res) => {
  try {
    const query = req.query.q;
    const limit = parseInt(req.query.limit) || 1;
    
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    // Search for songs in our database
    const songs = await Song.search(query, limit);
    
    console.log('Database search results:', songs.length);
    // If we have enough results, return them
    if (songs.length >= Math.floor(limit / 2)) {
      return res.json({ songs,success:true });
    }
    
    // Otherwise, try to search via Saavn API
    try {
    
      const response = await axios.get(`${process.env.MUSIC_API_URL}/song?query=${encodeURIComponent(query)}&lyrics=${true}&songdata=${true}`);
      console.log('Saavn API response:', response.data);
      if (response.data) {
        // Process and store the songs in the background
        for (const song of response.data.songs) {
          // Queue song data processing
          await songDataQueue.add(
            'process-song',
            { songId: song.id, checkSimilar: false,song:song },
            { 
              removeOnComplete: true,
              attempts: 3,
              backoff: {
                type: 'exponential',
                delay: 1000
              }
            }
          );
        }
        
        return res.json({...(response.data),success:true });
      }
    } catch (error) {
      console.error('Error searching via Saavn API:', error);
      // Continue with our database results if Saavn API fails
    }
    
    // Return whatever results we have from our database
    res.json({ songs,success:true });
  } catch (error) {
    console.error('Error searching songs:', error);
    res.status(500).json({ error: 'Server error searching songs',success:false });
  }
});

/**
 * @route   GET /api/songs/genre/:genre
 * @desc    Get songs by genre
 * @access  Public
 */
router.get('/genre/:genre', async (req, res) => {
  try {
    const genre = req.params.genre;
    const limit = parseInt(req.query.limit) || 20;
    
    // Get songs by genre
    const songs = await Song.getByGenre(genre, limit);
    
    res.json({ songs });
  } catch (error) {
    console.error('Error fetching songs by genre:', error);
    res.status(500).json({ error: 'Server error fetching songs by genre' });
  }
});

/**
 * @route   GET /api/songs/trending
 * @desc    Get trending songs
 * @access  Public
 */
router.get('/trending', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    
    // First try our database
    const songs = await MusicHistory.getTopSongsLastWeek();
    
    // If we have enough songs, return them
    if (songs.length >0) {
      return res.json({ songs });
    }

    
    
  
    // If all else fails, return random songs
    if (songs.length === 0) {
      const randomSongs = await Song.getRandom(limit);
      return res.json({ songs: randomSongs });
    }
    
    // Return whatever we got from the database
    res.json({ songs });
  } catch (error) {
    console.error('Error fetching trending songs:', error);
    res.status(500).json({ error: 'Server error fetching trending songs' });
  }
});

module.exports = router;