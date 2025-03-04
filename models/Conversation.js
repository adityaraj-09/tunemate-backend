// models/Conversation.js
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

/**
 * Conversation Model
 * Handles database operations for chat conversations
 */
class Conversation {
  /**
   * Get user's conversations
   * 
   * @param {string} userId - User ID
   * @returns {Promise<Array<Object>>} User's conversations with details
   */
  static async getUserConversations(userId) {
    const query = `
      WITH user_conversations AS (
        SELECT c.conversation_id, c.match_id, c.created_at, c.last_message_at,
               m.user_id_1, m.user_id_2,
               CASE WHEN m.user_id_1 = $1 THEN m.user_id_2 ELSE m.user_id_1 END AS other_user_id
        FROM conversations c
        JOIN matches m ON c.match_id = m.match_id
        WHERE m.user_id_1 = $1 OR m.user_id_2 = $1
      )
      SELECT uc.conversation_id, uc.match_id, uc.created_at, uc.last_message_at,
             u.user_id, u.username, u.first_name, u.last_name, u.profile_picture_url,
             (SELECT COUNT(*) FROM messages 
              WHERE conversation_id = uc.conversation_id 
              AND sender_id != $1 
              AND is_read = FALSE) AS unread_count,
             (SELECT message_text FROM messages 
              WHERE conversation_id = uc.conversation_id 
              ORDER BY sent_at DESC LIMIT 1) AS last_message,
             (SELECT sent_at FROM messages 
              WHERE conversation_id = uc.conversation_id 
              ORDER BY sent_at DESC LIMIT 1) AS last_message_time
      FROM user_conversations uc
      JOIN users u ON uc.other_user_id = u.user_id
      ORDER BY COALESCE(last_message_time, uc.created_at) DESC
    `;
    
    const result = await db.query(query, [userId]);
    
    return result.rows.map(row => ({
      id: row.conversation_id,
      matchId: row.match_id,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      otherUser: {
        id: row.user_id,
        username: row.username,
        firstName: row.first_name,
        lastName: row.last_name,
        profilePicture: row.profile_picture_url
      },
      lastMessage: row.last_message,
      lastMessageTime: row.last_message_time,
      unreadCount: parseInt(row.unread_count)
    }));
  }
  
  /**
   * Get conversation details
   * 
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<Object|null>} Conversation details or null if not found
   */
  static async getById(conversationId) {
    const query = `
      SELECT 
        c.conversation_id, c.match_id, c.created_at, c.last_message_at,
        m.user_id_1, m.user_id_2, m.match_score, m.status
      FROM conversations c
      JOIN matches m ON c.match_id = m.match_id
      WHERE c.conversation_id = $1
    `;
    
    const result = await db.query(query, [conversationId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const conversation = result.rows[0];
    
    // Get user details for both participants
    const usersQuery = `
      SELECT 
        user_id, username, first_name, last_name, profile_picture_url
      FROM users
      WHERE user_id = ANY($1)
    `;
    
    const usersResult = await db.query(usersQuery, [[conversation.user_id_1, conversation.user_id_2]]);
    
    const users = {};
    usersResult.rows.forEach(user => {
      users[user.user_id] = {
        id: user.user_id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        profilePicture: user.profile_picture_url
      };
    });
    
    return {
      id: conversation.conversation_id,
      matchId: conversation.match_id,
      createdAt: conversation.created_at,
      lastMessageAt: conversation.last_message_at,
      matchScore: parseFloat(conversation.match_score),
      status: conversation.status,
      participants: [
        users[conversation.user_id_1],
        users[conversation.user_id_2]
      ]
    };
  }
  
  /**
   * Verify a user has access to a conversation
   * 
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if user has access
   */
  static async verifyAccess(conversationId, userId) {
    const query = `
      SELECT EXISTS(
        SELECT 1
        FROM conversations c
        JOIN matches m ON c.match_id = m.match_id
        WHERE c.conversation_id = $1 AND (m.user_id_1 = $2 OR m.user_id_2 = $2)
      ) AS has_access
    `;
    
    const result = await db.query(query, [conversationId, userId]);
    return result.rows[0].has_access;
  }
  
  /**
   * Create a new conversation
   * 
   * @param {string} matchId - Match ID
   * @returns {Promise<Object>} Created conversation
   */
  static async create(matchId) {
    // Check if match exists and is in 'matched' status
    const matchQuery = `
      SELECT 
        match_id, user_id_1, user_id_2, status
      FROM matches
      WHERE match_id = $1 AND status = 'matched'
    `;
    
    const matchResult = await db.query(matchQuery, [matchId]);
    
    if (matchResult.rows.length === 0) {
      throw new Error('Match not found or not in matched status');
    }
    
    // Check if conversation already exists
    const existingQuery = `
      SELECT conversation_id
      FROM conversations
      WHERE match_id = $1
    `;
    
    const existingResult = await db.query(existingQuery, [matchId]);
    
    if (existingResult.rows.length > 0) {
      return {
        id: existingResult.rows[0].conversation_id,
        matchId,
        alreadyExists: true
      };
    }
    
    // Create new conversation
    const insertQuery = `
      INSERT INTO conversations (
        conversation_id, match_id, created_at, last_message_at
      )
      VALUES (
        $1, $2, NOW(), NULL
      )
      RETURNING conversation_id, created_at
    `;
    
    const conversationId = uuidv4();
    const result = await db.query(insertQuery, [conversationId, matchId]);
    
    return {
      id: result.rows[0].conversation_id,
      matchId,
      createdAt: result.rows[0].created_at,
      alreadyExists: false
    };
  }
  
  /**
   * Update the last message timestamp for a conversation
   * 
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<void>}
   */
  static async updateLastMessageTime(conversationId) {
    const query = `
      UPDATE conversations
      SET last_message_at = NOW()
      WHERE conversation_id = $1
    `;
    
    await db.query(query, [conversationId]);
  }
  
  /**
   * Archive a conversation
   * 
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if conversation was archived
   */
  static async archive(conversationId, userId) {
    // Check if user has access to this conversation
    const hasAccess = await this.verifyAccess(conversationId, userId);
    
    if (!hasAccess) {
      throw new Error('User does not have access to this conversation');
    }
    
    // Archive conversation for this user
    const query = `
      INSERT INTO user_conversation_status (
        status_id, conversation_id, user_id, is_archived, created_at
      )
      VALUES (
        $1, $2, $3, TRUE, NOW()
      )
      ON CONFLICT (conversation_id, user_id)
      DO UPDATE SET
        is_archived = TRUE,
        updated_at = NOW()
      RETURNING status_id
    `;
    
    const statusId = uuidv4();
    const result = await db.query(query, [statusId, conversationId, userId]);
    
    return result.rows.length > 0;
  }
  
  /**
   * Unarchive a conversation
   * 
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if conversation was unarchived
   */
  static async unarchive(conversationId, userId) {
    // Check if user has access to this conversation
    const hasAccess = await this.verifyAccess(conversationId, userId);
    
    if (!hasAccess) {
      throw new Error('User does not have access to this conversation');
    }
    
    // Unarchive conversation for this user
    const query = `
      INSERT INTO user_conversation_status (
        status_id, conversation_id, user_id, is_archived, created_at
      )
      VALUES (
        $1, $2, $3, FALSE, NOW()
      )
      ON CONFLICT (conversation_id, user_id)
      DO UPDATE SET
        is_archived = FALSE,
        updated_at = NOW()
      RETURNING status_id
    `;
    
    const statusId = uuidv4();
    const result = await db.query(query, [statusId, conversationId, userId]);
    
    return result.rows.length > 0;
  }
  
  /**
   * Delete a conversation (soft delete)
   * 
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if conversation was deleted
   */
  static async delete(conversationId, userId) {
    // Check if user has access to this conversation
    const hasAccess = await this.verifyAccess(conversationId, userId);
    
    if (!hasAccess) {
      throw new Error('User does not have access to this conversation');
    }
    
    // Mark conversation as deleted for this user
    const query = `
      INSERT INTO user_conversation_status (
        status_id, conversation_id, user_id, is_deleted, created_at
      )
      VALUES (
        $1, $2, $3, TRUE, NOW()
      )
      ON CONFLICT (conversation_id, user_id)
      DO UPDATE SET
        is_deleted = TRUE,
        updated_at = NOW()
      RETURNING status_id
    `;
    
    const statusId = uuidv4();
    const result = await db.query(query, [statusId, conversationId, userId]);
    
    return result.rows.length > 0;
  }
  
  /**
   * Get archived conversations for a user
   * 
   * @param {string} userId - User ID
   * @returns {Promise<Array<Object>>} Archived conversations
   */
  static async getArchivedConversations(userId) {
    const query = `
      WITH user_conversations AS (
        SELECT c.conversation_id, c.match_id, c.created_at, c.last_message_at,
               m.user_id_1, m.user_id_2,
               CASE WHEN m.user_id_1 = $1 THEN m.user_id_2 ELSE m.user_id_1 END AS other_user_id
        FROM conversations c
        JOIN matches m ON c.match_id = m.match_id
        JOIN user_conversation_status ucs ON c.conversation_id = ucs.conversation_id
        WHERE (m.user_id_1 = $1 OR m.user_id_2 = $1)
          AND ucs.user_id = $1
          AND ucs.is_archived = TRUE
          AND ucs.is_deleted = FALSE
      )
      SELECT uc.conversation_id, uc.match_id, uc.created_at, uc.last_message_at,
             u.user_id, u.username, u.first_name, u.last_name, u.profile_picture_url,
             (SELECT COUNT(*) FROM messages 
              WHERE conversation_id = uc.conversation_id 
              AND sender_id != $1 
              AND is_read = FALSE) AS unread_count,
             (SELECT message_text FROM messages 
              WHERE conversation_id = uc.conversation_id 
              ORDER BY sent_at DESC LIMIT 1) AS last_message
      FROM user_conversations uc
      JOIN users u ON uc.other_user_id = u.user_id
      ORDER BY uc.last_message_at DESC NULLS LAST
    `;
    
    const result = await db.query(query, [userId]);
    
    return result.rows.map(row => ({
      id: row.conversation_id,
      matchId: row.match_id,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      otherUser: {
        id: row.user_id,
        username: row.username,
        firstName: row.first_name,
        lastName: row.last_name,
        profilePicture: row.profile_picture_url
      },
      lastMessage: row.last_message,
      unreadCount: parseInt(row.unread_count)
    }));
  }
}

module.exports = Conversation;