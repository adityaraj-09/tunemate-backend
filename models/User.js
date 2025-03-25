// models/User.js
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const db = require('../config/database');

/**
 * User Model
 * Handles database operations for user entities
 */
class User {
  /**
   * Create a new user in the database
   * 
   * @param {Object} userData - User information
   * @param {string} userData.username - Unique username
   * @param {string} userData.email - User email
   * @param {string} userData.password - Plain text password (will be hashed)
   * @param {string} [userData.firstName] - User's first name
   * @param {string} [userData.lastName] - User's last name
   * @param {string} [userData.birthDate] - User's birth date (ISO format)
   * @param {string} [userData.gender] - User's gender
   * @param {string} [userData.bio] - User biography
   * @returns {Promise<Object>} Created user object (without password)
   */
  static async create(userData) {
    const { 
      username, 
      email, 
      password, 
      firstName = null, 
      lastName = null, 
      birthDate = null, 
      gender = null,
      bio = null
    } = userData;
    
    // Validate required fields
    if (!username || !email || !password) {
      throw new Error('Username, email and password are required');
    }
    
    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    
    // Generate UUID for user
    const userId = uuidv4();
    
    // Insert user into database
    const query = `
      INSERT INTO users (
        user_id, username, email, password_hash, first_name, last_name, 
        birth_date, gender, bio, created_at, last_login
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      RETURNING user_id, username, email, first_name, last_name, gender, bio, created_at
    `;
    
    const values = [
      userId, username, email, passwordHash, firstName, lastName, 
      birthDate, gender, bio
    ];
    
    try {
      const result = await db.query(query, values);
      return this.formatUser(result.rows[0]);
    } catch (error) {
      // Handle specific PostgreSQL error codes
      if (error.code === '23505') { // unique_violation
        if (error.constraint.includes('username')) {
          throw new Error('Username already exists');
        } else if (error.constraint.includes('email')) {
          throw new Error('Email already exists');
        }
      }
      
      throw error;
    }
  }
  
  /**
   * Find a user by their ID
   * 
   * @param {string} userId - User ID to find
   * @returns {Promise<Object|null>} User object or null if not found
   */
  static async findById(userId) {
    const query = `
      SELECT 
        user_id, username, email, first_name, last_name, birth_date, 
        gender, profile_picture_url, bio, created_at, last_login
      FROM users
      WHERE user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.formatUser(result.rows[0]);
  }
  
  /**
   * Find a user by their username
   * 
   * @param {string} username - Username to find
   * @returns {Promise<Object|null>} User object or null if not found
   */
  static async findByUsername(username) {
    const query = `
      SELECT 
        user_id, username, email, password_hash, first_name, last_name, 
        birth_date, gender, profile_picture_url, bio, created_at, last_login
      FROM users
      WHERE username = $1
    `;
    
    const result = await db.query(query, [username]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0]; // Include password_hash for authentication
  }
  
  /**
   * Find a user by their email
   * 
   * @param {string} email - Email to find
   * @returns {Promise<Object|null>} User object or null if not found
   */
  static async findByEmail(email) {
    const query = `
      SELECT 
        user_id, username, email, first_name, last_name, birth_date, 
        gender, profile_picture_url, bio, created_at, last_login
      FROM users
      WHERE email = $1
    `;
    
    const result = await db.query(query, [email]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.formatUser(result.rows[0]);
  }
  
  /**
   * Update a user's profile information
   * 
   * @param {string} userId - User ID to update
   * @param {Object} updateData - Fields to update
   * @param {string} [updateData.firstName] - Updated first name
   * @param {string} [updateData.lastName] - Updated last name
   * @param {string} [updateData.bio] - Updated biography
   * @param {string} [updateData.profilePicture] - Updated profile picture URL
   * @returns {Promise<Object>} Updated user object
   */
  static async update(userId, updateData) {
    const { 
      firstName, 
      lastName, 
      bio, 
      profilePicture 
    } = updateData;
    
    // Build query dynamically based on provided fields
    let setClause = [];
    let values = [userId];
    let paramIndex = 2;
    
    if (firstName !== undefined) {
      setClause.push(`first_name = $${paramIndex++}`);
      values.push(firstName);
    }
    
    if (lastName !== undefined) {
      setClause.push(`last_name = $${paramIndex++}`);
      values.push(lastName);
    }
    
    if (bio !== undefined) {
      setClause.push(`bio = $${paramIndex++}`);
      values.push(bio);
    }
    
    if (profilePicture !== undefined) {
      setClause.push(`profile_picture_url = $${paramIndex++}`);
      values.push(profilePicture);
    }
    
    if (setClause.length === 0) {
      throw new Error('No update fields provided');
    }
    
    const query = `
      UPDATE users
      SET ${setClause.join(', ')}
      WHERE user_id = $1
      RETURNING user_id, username, email, first_name, last_name, birth_date, 
                gender, profile_picture_url, bio, created_at, last_login
    `;
    
    const result = await db.query(query, values);
    
    if (result.rows.length === 0) {
      throw new Error('User not found');
    }
    
    return this.formatUser(result.rows[0]);
  }
  
  /**
   * Update a user's password
   * 
   * @param {string} userId - User ID to update
   * @param {string} newPassword - New plain text password
   * @returns {Promise<boolean>} True if successful
   */
  static async updatePassword(userId, newPassword) {
    // Hash new password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);
    
    const query = `
      UPDATE users
      SET password_hash = $1
      WHERE user_id = $2
    `;
    
    const result = await db.query(query, [passwordHash, userId]);
    
    return result.rowCount > 0;
  }
  
  /**
   * Update user's last login timestamp
   * 
   * @param {string} userId - User ID
   * @returns {Promise<void>}
   */
  static async updateLastLogin(userId) {
    const query = `
      UPDATE users
      SET last_login = NOW()
      WHERE user_id = $1
    `;
    
    await db.query(query, [userId]);
  }
  
  /**
   * Authenticate a user with username and password
   * 
   * @param {string} username - Username to authenticate
   * @param {string} password - Plain text password to verify
   * @returns {Promise<Object|null>} User object if authenticated, null otherwise
   */
  static async authenticate(username, password) {
    const user = await this.findByUsername(username) || await this.findByEmail(username);
    
    if (!user) {
      return null;
    }
    
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    
    if (!isPasswordValid) {
      return null;
    }
    
    // Update last login time
    await this.updateLastLogin(user.user_id);
    
    // Return user without password hash
    return this.formatUser(user);
  }

  /**
 * Authenticate a user with either username or email
 * 
 * @param {string} identifier - Username or email
 * @param {string} password - Plain text password to verify
 * @returns {Promise<Object|null>} User object if authenticated, null otherwise
 */
static async authenticateWithIdentifier(identifier, password) {
  // Check if identifier is an email
  const isEmail = identifier.includes('@');
  
  // Find user by either username or email
  const query = `
    SELECT 
      user_id, username, email, password_hash, first_name, last_name, 
      birth_date, gender, profile_picture_url, bio, created_at, last_login
    FROM users
    WHERE ${isEmail ? 'email' : 'username'} = $1
  `;
  
  const result = await db.query(query, [identifier]);
  
  if (result.rows.length === 0) {
    console.log('User not found');
    return null;
  }
  
  const user = result.rows[0];
  
  // Verify password
  const isPasswordValid = await bcrypt.compare(password, user.password_hash);
  
  if (!isPasswordValid) {
    console.log('Invalid password');
    return null;
  }
  
  // Update last login time
  await this.updateLastLogin(user.user_id);
  
  // Return user without password hash
  return this.formatUser(user);
}
  
  /**
   * Delete a user from the database
   * 
   * @param {string} userId - User ID to delete
   * @returns {Promise<boolean>} True if successful
   */
  static async delete(userId) {
    const query = `
      DELETE FROM users
      WHERE user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    
    return result.rowCount > 0;
  }
  
  /**
   * Format user object for external use (remove sensitive fields)
   * 
   * @param {Object} user - Raw user object from database
   * @returns {Object} Formatted user object
   */
  static formatUser(user) {
    if (!user) return null;
    
    return {
      id: user.user_id,
      username: user.username,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      birthDate: user.birth_date,
      gender: user.gender,
      profilePicture: user.profile_picture_url,
      bio: user.bio,
      createdAt: user.created_at,
      lastLogin: user.last_login,
      // Calculate age if birth_date is available
      age: user.birth_date ? this.calculateAge(user.birth_date) : null
    };
  }
  
  /**
   * Calculate age from birth date
   * 
   * @param {Date|string} birthDate - Birth date
   * @returns {number} Age in years
   */
  static calculateAge(birthDate) {
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    
    return age;
  }
}

module.exports = User;