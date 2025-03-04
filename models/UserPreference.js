// models/UserPreference.js
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

/**
 * UserPreference Model
 * Handles database operations for user dating preferences
 */
class UserPreference {
  /**
   * Find user preferences by user ID
   * 
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} User preferences or null if not found
   */
  static async findByUserId(userId) {
    const query = `
      SELECT 
        preference_id, user_id, preferred_gender, min_age, 
        max_age, max_distance, is_visible, created_at, updated_at
      FROM user_preferences
      WHERE user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.formatPreference(result.rows[0]);
  }
  
  /**
   * Create new user preferences
   * 
   * @param {string} userId - User ID
   * @param {Object} preferencesData - Preferences information
   * @param {string} [preferencesData.preferredGender] - Preferred gender for matches
   * @param {number} [preferencesData.minAge] - Minimum age for matches
   * @param {number} [preferencesData.maxAge] - Maximum age for matches
   * @param {number} [preferencesData.maxDistance] - Maximum distance for matches (km)
   * @param {boolean} [preferencesData.isVisible=true] - Whether user is visible to others
   * @returns {Promise<Object>} Created preferences
   */
  static async create(userId, preferencesData) {
    const { 
      preferredGender = null, 
      minAge = 18, 
      maxAge = 100, 
      maxDistance = 100, 
      isVisible = true 
    } = preferencesData;
    
    const query = `
      INSERT INTO user_preferences (
        preference_id, user_id, preferred_gender, min_age, 
        max_age, max_distance, is_visible, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING preference_id, user_id, preferred_gender, min_age, 
                max_age, max_distance, is_visible, created_at, updated_at
    `;
    
    const preferenceId = uuidv4();
    const values = [
      preferenceId, userId, preferredGender, minAge, 
      maxAge, maxDistance, isVisible
    ];
    
    const result = await db.query(query, values);
    
    return this.formatPreference(result.rows[0]);
  }
  
  /**
   * Update user preferences
   * 
   * @param {string} userId - User ID
   * @param {Object} preferencesData - Preferences information to update
   * @param {string} [preferencesData.preferredGender] - Preferred gender for matches
   * @param {number} [preferencesData.minAge] - Minimum age for matches
   * @param {number} [preferencesData.maxAge] - Maximum age for matches
   * @param {number} [preferencesData.maxDistance] - Maximum distance for matches (km)
   * @param {boolean} [preferencesData.isVisible] - Whether user is visible to others
   * @returns {Promise<Object>} Updated preferences
   */
  static async update(userId, preferencesData) {
    // Build query dynamically based on provided fields
    let setClause = [];
    let values = [userId];
    let paramIndex = 2;
    
    if (preferencesData.preferredGender !== undefined) {
      setClause.push(`preferred_gender = $${paramIndex++}`);
      values.push(preferencesData.preferredGender);
    }
    
    if (preferencesData.minAge !== undefined) {
      setClause.push(`min_age = $${paramIndex++}`);
      values.push(preferencesData.minAge);
    }
    
    if (preferencesData.maxAge !== undefined) {
      setClause.push(`max_age = $${paramIndex++}`);
      values.push(preferencesData.maxAge);
    }
    
    if (preferencesData.maxDistance !== undefined) {
      setClause.push(`max_distance = $${paramIndex++}`);
      values.push(preferencesData.maxDistance);
    }
    
    if (preferencesData.isVisible !== undefined) {
      setClause.push(`is_visible = $${paramIndex++}`);
      values.push(preferencesData.isVisible);
    }
    
    // Always update the updated_at timestamp
    setClause.push(`updated_at = NOW()`);
    
    if (setClause.length === 0) {
      throw new Error('No update fields provided');
    }
    
    const query = `
      UPDATE user_preferences
      SET ${setClause.join(', ')}
      WHERE user_id = $1
      RETURNING preference_id, user_id, preferred_gender, min_age, 
                max_age, max_distance, is_visible, created_at, updated_at
    `;
    
    const result = await db.query(query, values);
    
    if (result.rows.length === 0) {
      throw new Error('User preferences not found');
    }
    
    return this.formatPreference(result.rows[0]);
  }
  
  /**
   * Create or update user preferences
   * 
   * @param {string} userId - User ID
   * @param {Object} preferencesData - Preferences information
   * @returns {Promise<Object>} Created or updated preferences
   */
  static async updateOrCreate(userId, preferencesData) {
    // Check if preferences already exist
    const existingPreferences = await this.findByUserId(userId);
    
    if (existingPreferences) {
      // Update existing preferences
      return this.update(userId, preferencesData);
    } else {
      // Create new preferences
      return this.create(userId, preferencesData);
    }
  }
  
  /**
   * Delete user preferences
   * 
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if preferences were deleted
   */
  static async delete(userId) {
    const query = `
      DELETE FROM user_preferences
      WHERE user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    
    return result.rowCount > 0;
  }
  
  /**
   * Format preference object for external use
   * 
   * @param {Object} preference - Raw preference object from database
   * @returns {Object} Formatted preference object
   */
  static formatPreference(preference) {
    if (!preference) return null;
    
    return {
      id: preference.preference_id,
      userId: preference.user_id,
      preferredGender: preference.preferred_gender,
      minAge: preference.min_age,
      maxAge: preference.max_age,
      maxDistance: preference.max_distance,
      isVisible: preference.is_visible,
      createdAt: preference.created_at,
      updatedAt: preference.updated_at
    };
  }
}

module.exports = UserPreference;