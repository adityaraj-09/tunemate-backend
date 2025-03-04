// models/UserLocation.js
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

/**
 * UserLocation Model
 * Handles database operations for user geographical locations
 */
class UserLocation {
  /**
   * Find user location by user ID
   * 
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} User location or null if not found
   */
  static async findByUserId(userId) {
    const query = `
      SELECT 
        location_id, user_id, latitude, longitude, 
        city, state, country, last_updated
      FROM user_locations
      WHERE user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.formatLocation(result.rows[0]);
  }
  
  /**
   * Create new user location
   * 
   * @param {string} userId - User ID
   * @param {Object} locationData - Location information
   * @param {number} locationData.latitude - Latitude coordinate
   * @param {number} locationData.longitude - Longitude coordinate
   * @param {string} [locationData.city] - City name
   * @param {string} [locationData.state] - State/province name
   * @param {string} [locationData.country] - Country name
   * @returns {Promise<Object>} Created location
   */
  static async create(userId, locationData) {
    const { 
      latitude, 
      longitude, 
      city = null, 
      state = null, 
      country = null 
    } = locationData;
    
    // Validate required fields
    if (latitude === undefined || longitude === undefined) {
      throw new Error('Latitude and longitude are required');
    }
    
    const query = `
      INSERT INTO user_locations (
        location_id, user_id, latitude, longitude, 
        city, state, country, last_updated
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING location_id, user_id, latitude, longitude, 
                city, state, country, last_updated
    `;
    
    const locationId = uuidv4();
    const values = [
      locationId, userId, latitude, longitude, 
      city, state, country
    ];
    
    const result = await db.query(query, values);
    
    return this.formatLocation(result.rows[0]);
  }
  
  /**
   * Update user location
   * 
   * @param {string} userId - User ID
   * @param {Object} locationData - Location information to update
   * @param {number} [locationData.latitude] - Latitude coordinate
   * @param {number} [locationData.longitude] - Longitude coordinate
   * @param {string} [locationData.city] - City name
   * @param {string} [locationData.state] - State/province name
   * @param {string} [locationData.country] - Country name
   * @returns {Promise<Object>} Updated location
   */
  static async update(userId, locationData) {
    // Build query dynamically based on provided fields
    let setClause = [];
    let values = [userId];
    let paramIndex = 2;
    
    if (locationData.latitude !== undefined) {
      setClause.push(`latitude = $${paramIndex++}`);
      values.push(locationData.latitude);
    }
    
    if (locationData.longitude !== undefined) {
      setClause.push(`longitude = $${paramIndex++}`);
      values.push(locationData.longitude);
    }
    
    if (locationData.city !== undefined) {
      setClause.push(`city = $${paramIndex++}`);
      values.push(locationData.city);
    }
    
    if (locationData.state !== undefined) {
      setClause.push(`state = $${paramIndex++}`);
      values.push(locationData.state);
    }
    
    if (locationData.country !== undefined) {
      setClause.push(`country = $${paramIndex++}`);
      values.push(locationData.country);
    }
    
    // Always update the last_updated timestamp
    setClause.push(`last_updated = NOW()`);
    
    if (setClause.length === 0) {
      throw new Error('No update fields provided');
    }
    
    const query = `
      UPDATE user_locations
      SET ${setClause.join(', ')}
      WHERE user_id = $1
      RETURNING location_id, user_id, latitude, longitude, 
                city, state, country, last_updated
    `;
    
    const result = await db.query(query, values);
    
    if (result.rows.length === 0) {
      throw new Error('User location not found');
    }
    
    return this.formatLocation(result.rows[0]);
  }
  
  /**
   * Create or update user location
   * 
   * @param {string} userId - User ID
   * @param {Object} locationData - Location information
   * @returns {Promise<Object>} Created or updated location
   */
  static async updateOrCreate(userId, locationData) {
    // Check if location already exists
    const existingLocation = await this.findByUserId(userId);
    
    if (existingLocation) {
      // Update existing location
      return this.update(userId, locationData);
    } else {
      // Create new location
      return this.create(userId, locationData);
    }
  }
  
  /**
   * Find users near a location
   * 
   * @param {number} latitude - Latitude coordinate
   * @param {number} longitude - Longitude coordinate
   * @param {number} [radius=50] - Search radius in kilometers
   * @param {string} [excludeUserId] - User ID to exclude from results
   * @returns {Promise<Array<Object>>} Array of nearby users with distance
   */
  static async findNearby(latitude, longitude, radius = 50, excludeUserId = null) {
    // Use Haversine formula to calculate distance
    const query = `
      SELECT 
        u.user_id, u.username, u.first_name, u.last_name, 
        u.profile_picture_url, ul.latitude, ul.longitude,
        (
          6371 * acos(
            cos(radians($1)) * 
            cos(radians(ul.latitude)) * 
            cos(radians(ul.longitude) - radians($2)) + 
            sin(radians($1)) * 
            sin(radians(ul.latitude))
          )
        ) as distance
      FROM 
        user_locations ul
      JOIN 
        users u ON ul.user_id = u.user_id
      WHERE 
        (
          6371 * acos(
            cos(radians($1)) * 
            cos(radians(ul.latitude)) * 
            cos(radians(ul.longitude) - radians($2)) + 
            sin(radians($1)) * 
            sin(radians(ul.latitude))
          )
        ) <= $3
        ${excludeUserId ? 'AND u.user_id != $4' : ''}
      ORDER BY 
        distance
    `;
    
    const params = [latitude, longitude, radius];
    if (excludeUserId) params.push(excludeUserId);
    
    const result = await db.query(query, params);
    
    return result.rows.map(row => ({
      userId: row.user_id,
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      profilePicture: row.profile_picture_url,
      location: {
        latitude: row.latitude,
        longitude: row.longitude
      },
      distance: parseFloat(row.distance).toFixed(1) // Round to 1 decimal place
    }));
  }
  
  /**
   * Delete user location
   * 
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if location was deleted
   */
  static async delete(userId) {
    const query = `
      DELETE FROM user_locations
      WHERE user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    
    return result.rowCount > 0;
  }
  
  /**
   * Format location object for external use
   * 
   * @param {Object} location - Raw location object from database
   * @returns {Object} Formatted location object
   */
  static formatLocation(location) {
    if (!location) return null;
    
    return {
      id: location.location_id,
      userId: location.user_id,
      latitude: parseFloat(location.latitude),
      longitude: parseFloat(location.longitude),
      city: location.city,
      state: location.state,
      country: location.country,
      lastUpdated: location.last_updated
    };
  }
  
  /**
   * Get distance between two coordinates
   * 
   * @param {number} lat1 - Latitude of first point
   * @param {number} lon1 - Longitude of first point
   * @param {number} lat2 - Latitude of second point
   * @param {number} lon2 - Longitude of second point
   * @returns {number} Distance in kilometers
   */
  static getDistance(lat1, lon1, lat2, lon2) {
    // Convert degrees to radians
    const toRad = value => value * Math.PI / 180;
    
    const R = 6371; // Earth's radius in km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * 
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    
    return distance;
  }
}

module.exports = UserLocation;