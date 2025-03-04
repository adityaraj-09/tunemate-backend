// routes/chat.routes.js
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Song = require('../models/Song');
const Match = require('../models/Match');
const { publish, CHANNELS } = require('../config/redis');

/**
 * @route   GET /api/chats
 * @desc    Get user's conversations
 * @access  Private
 */
router.get('/', async (req, res) => {
  try {
    // Get user's conversations
    const conversations = await Conversation.getUserConversations(req.user.id);
    
    res.json({ conversations });
  } catch (error) {
    console.error('Error getting conversations:', error);
    res.status(500).json({ error: 'Server error fetching conversations' });
  }
});

/**
 * @route   GET /api/chats/:conversationId
 * @desc    Get conversation details
 * @access  Private
 */
router.get('/:conversationId', async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    
    // Verify access
    const hasAccess = await Conversation.verifyAccess(conversationId, req.user.id);
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }
    
    // Get conversation details
    const conversation = await Conversation.getById(conversationId);
    
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    res.json({ conversation });
  } catch (error) {
    console.error('Error getting conversation details:', error);
    res.status(500).json({ error: 'Server error fetching conversation details' });
  }
});

/**
 * @route   GET /api/chats/:conversationId/messages
 * @desc    Get messages for a conversation
 * @access  Private
 */
router.get('/:conversationId/messages', async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before; // Timestamp for pagination
    
    // Verify access
    const hasAccess = await Conversation.verifyAccess(conversationId, req.user.id);
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }
    
    // Get messages
    const messages = await Message.getMessages(conversationId, { limit, before });
    
    // Mark messages as read
    await Message.markAsRead(conversationId, req.user.id);
    
    res.json({ messages });
  } catch (error) {
    console.error('Error getting messages:', error);
    res.status(500).json({ error: 'Server error fetching messages' });
  }
});

/**
 * @route   POST /api/chats/:conversationId/messages
 * @desc    Send a message in a conversation
 * @access  Private
 */
router.post(
  '/:conversationId/messages',
  [
    check('text', 'Message text is required unless sharing a song').optional({
      nullable: true
    }).notEmpty(),
    check('sharedSongId', 'Shared song ID must be a valid string').optional({
      nullable: true
    }).notEmpty()
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const conversationId = req.params.conversationId;
      const { text, sharedSongId } = req.body;
      
      // Either text or sharedSongId must be provided
      if (!text && !sharedSongId) {
        return res.status(400).json({ 
          error: 'Either message text or shared song is required' 
        });
      }
      
      // Verify access
      const hasAccess = await Conversation.verifyAccess(conversationId, req.user.id);
      
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied to this conversation' });
      }
      
      // Get conversation to find the other participant
      const conversation = await Conversation.getById(conversationId);
      
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      
      // Find other user ID
      const otherUserId = conversation.participants.find(
        p => p.id !== req.user.id
      )?.id;
      
      // Verify shared song exists if provided
      if (sharedSongId) {
        const song = await Song.findById(sharedSongId);
        
        if (!song) {
          return res.status(404).json({ error: 'Shared song not found' });
        }
      }
      
      // Send message
      const message = await Message.send({
        conversationId,
        senderId: req.user.id,
        text: text || 'Check out this song!',
        sharedSongId
      });
      
      // Update conversation last message time
      await Conversation.updateLastMessageTime(conversationId);
      
      // Publish message event for real-time notifications
      if (otherUserId) {
        await publish(CHANNELS.CHAT_MESSAGE, {
          conversationId,
          messageId: message.id,
          senderId: req.user.id,
          recipientId: otherUserId,
          text: sentMessage.text,
          sentAt: sentMessage.sentAt,
          sharedSongId: sentMessage.sharedSongId
        });
      }
      
      res.status(201).json({
        message: 'Song shared successfully',
        sentMessage
      });
    } catch (error) {
      console.error('Error sharing song:', error);
      res.status(500).json({ error: 'Server error sharing song' });
    }
  }
);

/**
 * @route   DELETE /api/chats/:conversationId/messages/:messageId
 * @desc    Delete a message
 * @access  Private
 */
router.delete('/:conversationId/messages/:messageId', async (req, res) => {
  try {
    const { conversationId, messageId } = req.params;
    
    // Verify access to conversation
    const hasAccess = await Conversation.verifyAccess(conversationId, req.user.id);
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }
    
    // Delete message (this will verify the sender)
    const deleted = await Message.delete(messageId, req.user.id);
    
    if (!deleted) {
      return res.status(404).json({ error: 'Message not found or not sent by you' });
    }
    
    res.json({ message: 'Message deleted successfully' });
  } catch (error) {
    console.error('Error deleting message:', error);
    
    if (error.message.includes('sender')) {
      return res.status(403).json({ error: 'You can only delete your own messages' });
    }
    
    res.status(500).json({ error: 'Server error deleting message' });
  }
});

/**
 * @route   POST /api/chats/new/:matchId
 * @desc    Create a new conversation from a match
 * @access  Private
 */
router.post('/new/:matchId', async (req, res) => {
  try {
    const matchId = req.params.matchId;
    
    // Check if match exists and user is part of it
    const match = await Match.getMatchStatus(matchId);
    
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }
    
    if (match.user1Id !== req.user.id && match.user2Id !== req.user.id) {
      return res.status(403).json({ error: 'You are not part of this match' });
    }
    
    if (match.status !== 'matched') {
      return res.status(400).json({ error: 'Match is not in matched status' });
    }
    
    // Create conversation (or get existing one)
    const conversation = await Conversation.create(matchId);
    
    if (conversation.alreadyExists) {
      return res.json({
        message: 'Conversation already exists',
        conversation
      });
    }
    
    res.status(201).json({
      message: 'Conversation created successfully',
      conversation
    });
  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({ error: 'Server error creating conversation' });
  }
});

/**
 * @route   POST /api/chats/:conversationId/archive
 * @desc    Archive a conversation
 * @access  Private
 */
router.post('/:conversationId/archive', async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    
    // Verify access
    const hasAccess = await Conversation.verifyAccess(conversationId, req.user.id);
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }
    
    // Archive conversation
    await Conversation.archive(conversationId, req.user.id);
    
    res.json({ message: 'Conversation archived successfully' });
  } catch (error) {
    console.error('Error archiving conversation:', error);
    res.status(500).json({ error: 'Server error archiving conversation' });
  }
});

/**
 * @route   POST /api/chats/:conversationId/unarchive
 * @desc    Unarchive a conversation
 * @access  Private
 */
router.post('/:conversationId/unarchive', async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    
    // Verify access
    const hasAccess = await Conversation.verifyAccess(conversationId, req.user.id);
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }
    
    // Unarchive conversation
    await Conversation.unarchive(conversationId, req.user.id);
    
    res.json({ message: 'Conversation unarchived successfully' });
  } catch (error) {
    console.error('Error unarchiving conversation:', error);
    res.status(500).json({ error: 'Server error unarchiving conversation' });
  }
});

/**
 * @route   GET /api/chats/archived
 * @desc    Get archived conversations
 * @access  Private
 */
router.get('/archived', async (req, res) => {
  try {
    // Get archived conversations
    const conversations = await Conversation.getArchivedConversations(req.user.id);
    
    res.json({ conversations });
  } catch (error) {
    console.error('Error getting archived conversations:', error);
    res.status(500).json({ error: 'Server error fetching archived conversations' });
  }
});

/**
 * @route   GET /api/chats/unread
 * @desc    Get unread message counts
 * @access  Private
 */
router.get('/unread', async (req, res) => {
  try {
    // Get unread message counts
    const unreadCounts = await Message.getUnreadCounts(req.user.id);
    
    res.json({ unreadCounts });
  } catch (error) {
    console.error('Error getting unread counts:', error);
    res.status(500).json({ error: 'Server error fetching unread counts' });
  }
});

module.exports = router;

/**
 * @route   POST /api/chats/:conversationId/read
 * @desc    Mark all messages in a conversation as read
 * @access  Private
 */
router.post('/:conversationId/read', async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    
    // Verify access
    const hasAccess = await Conversation.verifyAccess(conversationId, req.user.id);
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }
    
    // Mark messages as read
    const count = await Message.markAsRead(conversationId, req.user.id);
    
    res.json({
      message: `Marked ${count} messages as read`,
      count
    });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Server error marking messages as read' });
  }
});

/**
 * @route   POST /api/chats/:conversationId/share-song
 * @desc    Share a song in a conversation
 * @access  Private
 */
router.post(
  '/:conversationId/share-song',
  [
    check('songId', 'Song ID is required').notEmpty(),
    check('message', 'Message must be a string if provided').optional().isString()
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const conversationId = req.params.conversationId;
      const { songId, message } = req.body;
      
      // Verify access
      const hasAccess = await Conversation.verifyAccess(conversationId, req.user.id);
      
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied to this conversation' });
      }
      
      // Verify song exists
      const song = await Song.findById(songId);
      
      if (!song) {
        return res.status(404).json({ error: 'Song not found' });
      }
      
      // Share song
      const sentMessage = await Message.shareSong(
        conversationId,
        req.user.id,
        songId,
        message || 'Check out this song!'
      );
      
      // Update conversation last message time
      await Conversation.updateLastMessageTime(conversationId);
      
      // Get conversation to find the other participant
      const conversation = await Conversation.getById(conversationId);
      
      // Find other user ID
      const otherUserId = conversation.participants.find(
        p => p.id !== req.user.id
      )?.id;
      
      // Publish message event for real-time notifications
      if (otherUserId) {
        await publish(CHANNELS.CHAT_MESSAGE, {
          conversationId,
          messageId: sentMessage.id,
          senderId: req.user.id,
          recipientId: otherUserId,
          text: message.text,
          sentAt: message.sentAt,
          sharedSongId: message.sharedSongId
        });
      }
      
      res.status(201).json({ message });
    } catch (error) {
      console.error('Error sending message:', error);
      res.status(500).json({ error: 'Server error sending message' });
    }
  }
);