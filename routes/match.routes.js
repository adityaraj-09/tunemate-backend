// routes/match.routes.js
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const Match = require('../models/Match');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const MusicHistory = require('../models/MusicHistory');
const { publish, CHANNELS } = require('../config/redis');

/**
 * @route   GET /api/matches
 * @desc    Get potential matches for user
 * @access  Private
 */
router.get('/', async (req, res) => {
  try {
    const minScore = parseInt(req.query.minScore) || 60;
    const limit = parseInt(req.query.limit) || 20;
    
    // Get potential matches for user
    const matches = await Match.getPotentialMatches(req.user.id, {
      minScore,
      limit
    });
    
    res.json({ matches });
  } catch (error) {
    console.error('Error getting matches:', error);
    
    if (error.message.includes('location not found')) {
      return res.status(400).json({ error: 'Please update your location to see matches' });
    }
    
    res.status(500).json({ error: 'Server error fetching matches' });
  }
});

/**
 * @route   GET /api/matches/:matchId
 * @desc    Get details for a specific match
 * @access  Private
 */
router.get('/:matchId', async (req, res) => {
  try {
    const matchId = req.params.matchId;
    
    // Get match details
    const match = await Match.getMatchStatus(matchId);
    
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }
    
    // Verify user is part of this match
    if (match.user1Id !== req.user.id && match.user2Id !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized access to this match' });
    }
    
    // Get other user's details
    const otherUserId = match.user1Id === req.user.id ? match.user2Id : match.user1Id;
    const otherUser = await User.findById(otherUserId);
    
    // Get common songs
    const commonSongs = await MusicHistory.getCommonSongs(req.user.id, otherUserId);
    
    res.json({
      match: {
        ...match,
        otherUser,
        commonSongs
      }
    });
  } catch (error) {
    console.error('Error getting match details:', error);
    res.status(500).json({ error: 'Server error fetching match details' });
  }
});

/**
 * @route   POST /api/matches/:matchId/action
 * @desc    Take action on a match (like, pass)
 * @access  Private
 */
router.post(
  '/:matchId/action',
  [
    check('action', 'Action must be either "liked" or "passed"').isIn(['liked', 'passed'])
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const matchId = req.params.matchId;
      const { action } = req.body;
      
      // Update match status
      const updatedMatch = await Match.updateStatus(matchId, req.user.id, action);
      
      // If match status is now 'matched', create a conversation
      if (updatedMatch.status === 'matched') {
        const conversation = await Conversation.create(matchId);
        
        // Publish match event for real-time notifications
        const otherUserId = updatedMatch.user1Id === req.user.id ? updatedMatch.user2Id : updatedMatch.user1Id;
        await publish(CHANNELS.MATCH_UPDATE, {
          matchId,
          userId: otherUserId,
          status: 'matched',
          initiatedBy: req.user.id,
          conversationId: conversation.id
        });
        
        return res.json({
          message: 'Match created!',
          match: updatedMatch,
          conversation
        });
      }
      
      res.json({
        message: `Match ${action === 'liked' ? 'liked' : 'passed'}`,
        match: updatedMatch
      });
    } catch (error) {
      console.error('Error updating match status:', error);
      
      if (error.message.includes('not found') || error.message.includes('not part of match')) {
        return res.status(404).json({ error: error.message });
      }
      
      res.status(500).json({ error: 'Server error updating match status' });
    }
  }
);

/**
 * @route   GET /api/matches/matched
 * @desc    Get all matches with 'matched' status
 * @access  Private
 */
router.get('/matched', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    // Get user's matches with 'matched' status
    const matches = await Match.getUserMatches(req.user.id, 'matched', {
      limit,
      offset
    });
    
    res.json({ matches });
  } catch (error) {
    console.error('Error getting matched users:', error);
    res.status(500).json({ error: 'Server error fetching matched users' });
  }
});

/**
 * @route   GET /api/matches/stats
 * @desc    Get stats about user's matches
 * @access  Private
 */
router.get('/stats', async (req, res) => {
  try {
    // Count matches by status
    const matched = await Match.countByStatus(req.user.id, 'matched');
    const pending = await Match.countByStatus(req.user.id, 'pending');
    const liked = await Match.countUserActions(req.user.id, 'liked');
    const passed = await Match.countUserActions(req.user.id, 'passed');
    
    // Calculate match rate (matches / likes)
    const matchRate = liked > 0 ? (matched / liked) * 100 : 0;
    
    res.json({
      stats: {
        matched,
        pending,
        liked,
        passed,
        matchRate: Math.round(matchRate * 10) / 10 // Round to 1 decimal place
      }
    });
  } catch (error) {
    console.error('Error getting match stats:', error);
    res.status(500).json({ error: 'Server error fetching match stats' });
  }
});

/**
 * @route   GET /api/matches/common/:userId
 * @desc    Get common songs with another user
 * @access  Private
 */
router.get('/common/:userId', async (req, res) => {
  try {
    const otherUserId = req.params.userId;
    
    // Verify there is a match between users
    const matchExists = await Match.existsBetweenUsers(req.user.id, otherUserId);
    
    if (!matchExists) {
      return res.status(403).json({ error: 'No match exists with this user' });
    }
    
    // Get common songs
    const commonSongs = await MusicHistory.getCommonSongs(req.user.id, otherUserId);
    
    res.json({ commonSongs });
  } catch (error) {
    console.error('Error getting common songs:', error);
    res.status(500).json({ error: 'Server error fetching common songs' });
  }
});

/**
 * @route   DELETE /api/matches/:matchId
 * @desc    Unmatch with a user
 * @access  Private
 */
router.delete('/:matchId', async (req, res) => {
  try {
    const matchId = req.params.matchId;
    
    // Verify user is part of this match
    const match = await Match.getMatchStatus(matchId);
    
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }
    
    if (match.user1Id !== req.user.id && match.user2Id !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized access to this match' });
    }
    
    // Unmatch users
    await Match.unmatch(matchId);
    
    // Delete any conversation
    const conversation = await Conversation.findByMatchId(matchId);
    if (conversation) {
      await Conversation.delete(conversation.id, req.user.id);
    }
    
    // Notify other user
    const otherUserId = match.user1Id === req.user.id ? match.user2Id : match.user1Id;
    await publish(CHANNELS.MATCH_UPDATE, {
      matchId,
      userId: otherUserId,
      status: 'unmatched',
      initiatedBy: req.user.id
    });
    
    res.json({ message: 'Successfully unmatched' });
  } catch (error) {
    console.error('Error unmatching:', error);
    res.status(500).json({ error: 'Server error during unmatch' });
  }
});

/**
 * @route   POST /api/matches/recalculate
 * @desc    Request match score recalculation
 * @access  Private
 */
router.post('/recalculate', async (req, res) => {
  try {
    // Queue user for match recalculation
    await Match.queueForRecalculation(req.user.id);
    
    res.json({ message: 'Match recalculation queued' });
  } catch (error) {
    console.error('Error queueing match recalculation:', error);
    res.status(500).json({ error: 'Server error queueing match recalculation' });
  }
});

module.exports = router;