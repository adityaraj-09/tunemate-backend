// models/Message.js
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const Conversation = require('./Conversation');

/**
 * Message Model
 * Handles database operations for chat messages
 */
class Message {
  /**
   * Get messages for a conversation
   * 
   * @param {string} conversationId - Conversation ID
   * @param {Object} options - Query options
   * @param {number} [options.limit=50] - Maximum number of results
   * @param {string} [options.before] - Timestamp to get messages before
   * @returns {Promise<Array<Object>>} Messages in the conversation
   */
  static async getMessages(conversationId, { limit = 50, before } = {}) {
    // Construct the query for messages
    let messagesQuery = `
      SELECT 
        m.message_id, m.conversation_id, m.sender_id, 
        u.username, u.profile_picture_url,
        m.message_text, m.sent_at, m.is_read,
        m.attachment_url, ss.song_id
      FROM 
        messages m
      JOIN 
        users u ON m.sender_id = u.user_id
      LEFT JOIN 
        shared_songs ss ON m.message_id = ss.message_id
      WHERE 
        m.conversation_id = $1
    `;
    
    const queryParams = [conversationId];
    
    // Add before timestamp condition if provided
    if (before) {
      messagesQuery += ` AND m.sent_at < $${queryParams.length + 1}`;
      queryParams.push(before);
    }
    
    messagesQuery += `
      ORDER BY m.sent_at DESC
      LIMIT $${queryParams.length + 1}
    `;
    
    queryParams.push(limit);
    
    const messagesResult = await db.query(messagesQuery, queryParams);
    
    // Get song details for shared songs
    const songIds = messagesResult.rows
      .filter(row => row.song_id)
      .map(row => row.song_id);
    
    let songDetails = {};
    
    if (songIds.length > 0) {
      const songsQuery = `
        SELECT 
          song_id, song_name, album, primary_artists, image_url, media_url
        FROM 
          songs
        WHERE 
          song_id = ANY($1)
      `;
      
      const songsResult = await db.query(songsQuery, [songIds]);
      
      songDetails = songsResult.rows.reduce((acc, song) => {
        acc[song.song_id] = {
          id: song.song_id,
          name: song.song_name,
          album: song.album,
          artists: song.primary_artists,
          imageUrl: song.image_url,
          mediaUrl: song.media_url
        };
        return acc;
      }, {});
    }
    
    return messagesResult.rows.map(row => ({
      id: row.message_id,
      conversationId: row.conversation_id,
      sender: {
        id: row.sender_id,
        username: row.username,
        profilePicture: row.profile_picture_url
      },
      text: row.message_text,
      sentAt: row.sent_at,
      isRead: row.is_read,
      attachmentUrl: row.attachment_url,
      sharedSong: row.song_id ? {
        ...songDetails[row.song_id]
      } : null
    }));
  }
  
  /**
   * Send a message in a conversation
   * 
   * @param {Object} messageData - Message data
   * @param {string} messageData.conversationId - Conversation ID
   * @param {string} messageData.senderId - Sender user ID
   * @param {string} messageData.text - Message text
   * @param {string} [messageData.sharedSongId] - Shared song ID
   * @param {string} [messageData.attachmentUrl] - Attachment URL
   * @returns {Promise<Object>} Created message
   */
  static async send(messageData) {
    const { 
      conversationId, 
      senderId, 
      text, 
      sharedSongId,
      attachmentUrl
    } = messageData;
    
    // Verify user has access to this conversation
    const hasAccess = await Conversation.verifyAccess(conversationId, senderId);
    
    if (!hasAccess) {
      throw new Error('User does not have access to this conversation');
    }
    
    // Start a transaction
    return db.transaction(async (client) => {
      // Insert message
      const messageId = uuidv4();
      const insertMessageQuery = `
        INSERT INTO messages (
          message_id, conversation_id, sender_id, 
          message_text, attachment_url, sent_at, is_read
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), FALSE)
        RETURNING message_id, sent_at
      `;
      
      const messageResult = await client.query(insertMessageQuery, [
        messageId, conversationId, senderId, text, attachmentUrl
      ]);
      
      // If a song is shared, add it to shared_songs
      if (sharedSongId) {
        const insertSharedSongQuery = `
          INSERT INTO shared_songs (
            shared_id, message_id, song_id, shared_at
          )
          VALUES (uuid_generate_v4(), $1, $2, NOW())
        `;
        
        await client.query(insertSharedSongQuery, [messageId, sharedSongId]);
      }
      
      // Update conversation last_message_at
      const updateConversationQuery = `
        UPDATE conversations
        SET last_message_at = NOW()
        WHERE conversation_id = $1
      `;
      
      await client.query(updateConversationQuery, [conversationId]);
      
      return {
        id: messageResult.rows[0].message_id,
        conversationId,
        senderId,
        text,
        sentAt: messageResult.rows[0].sent_at,
        isRead: false,
        attachmentUrl,
        sharedSongId
      };
    });
  }
  
  /**
   * Mark messages as read
   * 
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID reading the messages
   * @returns {Promise<number>} Number of messages marked as read
   */
  static async markAsRead(conversationId, userId) {
    // Verify user has access to this conversation
    const hasAccess = await Conversation.verifyAccess(conversationId, userId);
    
    if (!hasAccess) {
      throw new Error('User does not have access to this conversation');
    }
    
    // Mark messages from other users as read
    const query = `
      UPDATE messages
      SET is_read = TRUE
      WHERE conversation_id = $1 AND sender_id != $2 AND is_read = FALSE
      RETURNING message_id
    `;
    
    const result = await db.query(query, [conversationId, userId]);
    
    return result.rows.length;
  }
  
  /**
   * Get unread message counts for a user across all conversations
   * 
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Object with conversation IDs as keys and unread counts as values
   */
  static async getUnreadCounts(userId) {
    const query = `
      WITH user_conversations AS (
        SELECT c.conversation_id
        FROM conversations c
        JOIN matches m ON c.match_id = m.match_id
        WHERE m.user_id_1 = $1 OR m.user_id_2 = $1
      )
      SELECT 
        conversation_id, 
        COUNT(*) AS unread_count
      FROM messages
      WHERE 
        conversation_id IN (SELECT conversation_id FROM user_conversations)
        AND sender_id != $1
        AND is_read = FALSE
      GROUP BY conversation_id
    `;
    
    const result = await db.query(query, [userId]);
    
    const counts = {};
    result.rows.forEach(row => {
      counts[row.conversation_id] = parseInt(row.unread_count);
    });
    
    return counts;
  }
  
  /**
   * Delete a message
   * 
   * @param {string} messageId - Message ID
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if message was deleted
   */
  static async delete(messageId, userId) {
    // Verify user is the sender of this message
    const verifyQuery = `
      SELECT sender_id
      FROM messages
      WHERE message_id = $1
    `;
    
    const verifyResult = await db.query(verifyQuery, [messageId]);
    
    if (verifyResult.rows.length === 0) {
      throw new Error('Message not found');
    }
    
    if (verifyResult.rows[0].sender_id !== userId) {
      throw new Error('User is not the sender of this message');
    }
    
    // Soft delete the message
    const deleteQuery = `
      UPDATE messages
      SET is_deleted = TRUE
      WHERE message_id = $1
      RETURNING message_id
    `;
    
    const result = await db.query(deleteQuery, [messageId]);
    
    return result.rows.length > 0;
  }
  
  /**
   * Share a song in a message
   * 
   * @param {string} conversationId - Conversation ID
   * @param {string} senderId - Sender user ID
   * @param {string} songId - Song ID to share
   * @param {string} [message='Check out this song!'] - Optional message text
   * @returns {Promise<Object>} Created message with shared song
   */
  static async shareSong(conversationId, senderId, songId, message = 'Check out this song!') {
    return this.send({
      conversationId,
      senderId,
      text: message,
      sharedSongId: songId
    });
  }
}

module.exports = Message;