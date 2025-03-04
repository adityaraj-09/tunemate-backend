// models/Match.js
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { asyncRedis } = require('../config/redis');

/**
 * Match Model
 * Handles database operations for user matches
 */
class Match {
  /**
   * Get potential matches for a user
   * 
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {number} [options.minScore=60] - Minimum match score
   * @param {number} [options.limit=20] - Maximum number of results
   * @returns {Promise<Array<Object>>} Potential matches with details
   */
  static async getPotentialMatches(userId, { minScore = 60, limit = 20 } = {}) {
    // First, get user's preferences and location
    const userPrefsQuery = `
      SELECT 
        up.preferred_gender, up.min_age, up.max_age, up.max_distance,
        ul.latitude, ul.longitude
      FROM 
        user_preferences up
      LEFT JOIN 
        user_locations ul ON up.user_id = ul.user_id
      WHERE 
        up.user_id = $1
    `;
    
    const userPrefsResult = await db.query(userPrefsQuery, [userId]);
    
    if (userPrefsResult.rows.length === 0 || !userPrefsResult.rows[0].latitude) {
      throw new Error('User preferences or location not found');
    }
    
    const userPrefs = userPrefsResult.rows[0];
    
    // Find users based on preferences and location
    const potentialMatchesQuery = `
      WITH potential_users AS (
        SELECT 
          u.user_id,
          EXTRACT(YEAR FROM AGE(CURRENT_DATE, u.birth_date)) as age,
          (
            6371 * acos(
              cos(radians($1)) * 
              cos(radians(ul.latitude)) * 
              cos(radians(ul.longitude) - radians($2)) + 
              sin(radians($1)) * 
              sin(radians(ul.latitude))
            )
          ) as distance
        FROM users u
        JOIN user_locations ul ON u.user_id = ul.user_id
        JOIN user_preferences up ON u.user_id = up.user_id
        WHERE u.user_id != $3
          AND up.is_visible = TRUE
          AND ($4::VARCHAR IS NULL OR u.gender = $4)
          AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, u.birth_date)) BETWEEN $5 AND $6
          AND (
            6371 * acos(
              cos(radians($1)) * 
              cos(radians(ul.latitude)) * 
              cos(radians(ul.longitude) - radians($2)) + 
              sin(radians($1)) * 
              sin(radians(ul.latitude))
            )
          ) <= $7
      )
      SELECT user_id, distance
      FROM potential_users
    `;
    
    const potentialMatches = await db.query(potentialMatchesQuery, [
      userPrefs.latitude,
      userPrefs.longitude,
      userId,
      userPrefs.preferred_gender,
      userPrefs.min_age || 18,
      userPrefs.max_age || 100,
      userPrefs.max_distance || 100
    ]);
    
    // Calculate music compatibility for each potential match
    const matchResults = [];
    
    for (const match of potentialMatches.rows) {
      // Check for cached score
      const scoreKey = `match:score:${userId}:${match.user_id}`;
      let matchScore = await asyncRedis.get(scoreKey);
      
      if (!matchScore) {
        // Calculate match score
        matchScore = await this.calculateMatchScore(userId, match.user_id);
        
        // Cache score for 24 hours
        await asyncRedis.set(scoreKey, matchScore.toString(), 'EX', 86400);
      } else {
        matchScore = parseFloat(matchScore);
      }
      
      if (matchScore >= minScore) {
        // Apply distance adjustment
        const proximityFactor = Math.max(0, 1 - (match.distance / (userPrefs.max_distance || 100)));
        const adjustedScore = (matchScore * 0.8) + (proximityFactor * 100 * 0.2);
        
        matchResults.push({
          userId: match.user_id,
          score: adjustedScore,
          musicScore: matchScore,
          distance: parseFloat(match.distance)
        });
      }
    }
    
    // Sort by score and limit results
    matchResults.sort((a, b) => b.score - a.score);
    const topMatches = matchResults.slice(0, limit);
    
    // Get user details for the matches
    if (topMatches.length > 0) {
      const userIds = topMatches.map(match => match.userId);
      const userDetailsQuery = `
        SELECT 
          u.user_id,
          u.username,
          u.first_name,
          u.last_name,
          u.gender,
          u.profile_picture_url,
          u.bio,
          EXTRACT(YEAR FROM AGE(CURRENT_DATE, u.birth_date)) as age
        FROM 
          users u
        WHERE 
          u.user_id = ANY($1)
      `;
      
      const userDetailsResult = await db.query(userDetailsQuery, [userIds]);
      const userDetails = {};
      
      userDetailsResult.rows.forEach(user => {
        userDetails[user.user_id] = {
          username: user.username,
          firstName: user.first_name,
          lastName: user.last_name,
          gender: user.gender,
          age: parseInt(user.age),
          profilePicture: user.profile_picture_url,
          bio: user.bio
        };
      });
      
      // Enrich match results with user details
      for (const match of topMatches) {
        match.userDetails = userDetails[match.userId] || {};
      }
    }
    
    return topMatches;
  }
  
  /**
   * Calculate match score between two users
   * 
   * @param {string} user1Id - First user ID
   * @param {string} user2Id - Second user ID
   * @returns {Promise<number>} Match score (0-100)
   */
  static async calculateMatchScore(user1Id, user2Id) {
    // Initialize component scores
    let totalScore = 0;
    let maxPossibleScore = 0;
    
    // ============ COMPONENT 1: COMMON SONGS (35%) ============
    const songQuery = `
      SELECT 
        a.song_id, 
        a.play_count AS user1_count,
        b.play_count AS user2_count
      FROM 
        user_music_history a
      JOIN 
        user_music_history b ON a.song_id = b.song_id
      WHERE 
        a.user_id = $1 AND b.user_id = $2
    `;
    
    const user1SongsQuery = `
      SELECT song_id, play_count
      FROM user_music_history
      WHERE user_id = $1
    `;
    
    const user2SongsQuery = `
      SELECT song_id, play_count
      FROM user_music_history
      WHERE user_id = $1
    `;
    
    const [commonSongsResult, user1SongsResult, user2SongsResult] = await Promise.all([
      db.query(songQuery, [user1Id, user2Id]),
      db.query(user1SongsQuery, [user1Id]),
      db.query(user2SongsQuery, [user2Id])
    ]);
    
    const commonSongs = commonSongsResult.rows;
    const user1Songs = user1SongsResult.rows;
    const user2Songs = user2SongsResult.rows;
    
    const songJaccardSimilarity = user1Songs.length && user2Songs.length ?
      commonSongs.length / (user1Songs.length + user2Songs.length - commonSongs.length) : 0;
    
    const songScore = songJaccardSimilarity * 35;
    totalScore += songScore;
    maxPossibleScore += 35;
    
    // ============ COMPONENT 2: ARTISTS SIMILARITY (25%) ============
    const artistQuery = `
      WITH user1_artists AS (
        SELECT 
          unnest(string_to_array(s.primary_artists, ',')) AS artist,
          sum(umh.play_count) AS play_count
        FROM 
          user_music_history umh
        JOIN 
          songs s ON umh.song_id = s.song_id
        WHERE 
          umh.user_id = $1
        GROUP BY 
          artist
      ),
      user2_artists AS (
        SELECT 
          unnest(string_to_array(s.primary_artists, ',')) AS artist,
          sum(umh.play_count) AS play_count
        FROM 
          user_music_history umh
        JOIN 
          songs s ON umh.song_id = s.song_id
        WHERE 
          umh.user_id = $2
        GROUP BY 
          artist
      )
      SELECT 
        u1.artist,
        u1.play_count AS user1_count,
        u2.play_count AS user2_count
      FROM 
        user1_artists u1
      JOIN 
        user2_artists u2 ON trim(u1.artist) = trim(u2.artist)
    `;
    
    const commonArtistsResult = await db.query(artistQuery, [user1Id, user2Id]);
    const commonArtists = commonArtistsResult.rows;
    
    // Get total play counts
    const user1ArtistPlayCount = user1Songs.reduce((sum, song) => sum + parseInt(song.play_count), 0);
    const user2ArtistPlayCount = user2Songs.reduce((sum, song) => sum + parseInt(song.play_count), 0);
    
    // Calculate artist overlap score
    const commonArtistWeight = commonArtists.reduce((sum, row) => 
      sum + Math.min(parseInt(row.user1_count || 0), parseInt(row.user2_count || 0)), 0);
    
    const artistMatchScore = (user1ArtistPlayCount || user2ArtistPlayCount) ?
      (commonArtistWeight / Math.max(user1ArtistPlayCount, user2ArtistPlayCount)) * 25 : 0;
    
    totalScore += artistMatchScore;
    maxPossibleScore += 25;
    
    // ============ COMPONENT 3: GENRE PREFERENCES (20%) ============
    const genreQuery = `
      WITH user1_genres AS (
        SELECT 
          genre,
          sum(preference_weight) AS weight
        FROM 
          user_music_preferences
        WHERE 
          user_id = $1 AND genre IS NOT NULL
        GROUP BY 
          genre
      ),
      user2_genres AS (
        SELECT 
          genre,
          sum(preference_weight) AS weight
        FROM 
          user_music_preferences
        WHERE 
          user_id = $2 AND genre IS NOT NULL
        GROUP BY 
          genre
      ),
      all_genres AS (
        SELECT DISTINCT genre FROM 
        (SELECT genre FROM user1_genres 
         UNION 
         SELECT genre FROM user2_genres) t
      )
      SELECT 
        g.genre,
        COALESCE(u1.weight, 0) AS user1_weight,
        COALESCE(u2.weight, 0) AS user2_weight
      FROM 
        all_genres g
      LEFT JOIN 
        user1_genres u1 ON g.genre = u1.genre
      LEFT JOIN 
        user2_genres u2 ON g.genre = u2.genre
    `;
    
    const genresResult = await db.query(genreQuery, [user1Id, user2Id]);
    const genres = genresResult.rows;
    
    // Calculate cosine similarity for genres
    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;
    
    for (const genre of genres) {
      dotProduct += parseFloat(genre.user1_weight || 0) * parseFloat(genre.user2_weight || 0);
      magnitude1 += parseFloat(genre.user1_weight || 0) * parseFloat(genre.user1_weight || 0);
      magnitude2 += parseFloat(genre.user2_weight || 0) * parseFloat(genre.user2_weight || 0);
    }
    
    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);
    
    let genreScore = 0;
    if (magnitude1 > 0 && magnitude2 > 0) {
      const cosineSimilarity = dotProduct / (magnitude1 * magnitude2);
      genreScore = cosineSimilarity * 20;
    }
    
    totalScore += genreScore;
    maxPossibleScore += 20;
    
    // ============ COMPONENT 4: LISTENING PATTERNS (10%) ============
    const patternQuery = `
      WITH user1_patterns AS (
        SELECT 
          EXTRACT(HOUR FROM last_played) AS hour,
          COUNT(*) AS count
        FROM 
          user_music_history
        WHERE 
          user_id = $1
        GROUP BY 
          EXTRACT(HOUR FROM last_played)
      ),
      user2_patterns AS (
        SELECT 
          EXTRACT(HOUR FROM last_played) AS hour,
          COUNT(*) AS count
        FROM 
          user_music_history
        WHERE 
          user_id = $2
        GROUP BY 
          EXTRACT(HOUR FROM last_played)
      ),
      all_hours AS (
        SELECT hour FROM generate_series(0, 23) AS hour
      )
      SELECT 
        h.hour,
        COALESCE(u1.count, 0) AS user1_count,
        COALESCE(u2.count, 0) AS user2_count
      FROM 
        all_hours h
      LEFT JOIN 
        user1_patterns u1 ON h.hour = u1.hour
      LEFT JOIN 
        user2_patterns u2 ON h.hour = u2.hour
    `;
    
    const patternsResult = await db.query(patternQuery, [user1Id, user2Id]);
    const patterns = patternsResult.rows;
    
    // Normalize patterns and calculate similarity
    const user1Total = patterns.reduce((sum, p) => sum + parseInt(p.user1_count || 0), 0) || 1;
    const user2Total = patterns.reduce((sum, p) => sum + parseInt(p.user2_count || 0), 0) || 1;
    
    const user1Vector = patterns.map(p => parseInt(p.user1_count || 0) / user1Total);
    const user2Vector = patterns.map(p => parseInt(p.user2_count || 0) / user2Total);
    
    // Calculate cosine similarity for patterns
    dotProduct = 0;
    magnitude1 = 0;
    magnitude2 = 0;
    
    for (let i = 0; i < 24; i++) {
      dotProduct += user1Vector[i] * user2Vector[i];
      magnitude1 += user1Vector[i] * user1Vector[i];
      magnitude2 += user2Vector[i] * user2Vector[i];
    }
    
    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);
    
    let patternScore = 0;
    if (magnitude1 > 0 && magnitude2 > 0) {
      const cosineSimilarity = dotProduct / (magnitude1 * magnitude2);
      patternScore = cosineSimilarity * 10;
    }
    
    totalScore += patternScore;
    maxPossibleScore += 10;
    
    // ============ COMPONENT 5: MUSIC RECENCY (10%) ============
    const yearQuery = `
      WITH user1_years AS (
        SELECT 
          s.release_year,
          SUM(umh.play_count) AS count
        FROM 
          user_music_history umh
        JOIN 
          songs s ON umh.song_id = s.song_id
        WHERE 
          umh.user_id = $1 AND s.release_year IS NOT NULL
        GROUP BY 
          s.release_year
      ),
      user2_years AS (
        SELECT 
          s.release_year,
          SUM(umh.play_count) AS count
        FROM 
          user_music_history umh
        JOIN 
          songs s ON umh.song_id = s.song_id
        WHERE 
          umh.user_id = $2 AND s.release_year IS NOT NULL
        GROUP BY 
          s.release_year
      ),
      user1_decades AS (
        SELECT 
          (FLOOR(release_year::numeric / 10) * 10)::integer AS decade,
          SUM(count) AS count
        FROM 
          user1_years
        GROUP BY 
          decade
      ),
      user2_decades AS (
        SELECT 
          (FLOOR(release_year::numeric / 10) * 10)::integer AS decade,
          SUM(count) AS count
        FROM 
          user2_years
        GROUP BY 
          decade
      ),
      all_decades AS (
        SELECT DISTINCT decade FROM 
        (SELECT decade FROM user1_decades 
         UNION 
         SELECT decade FROM user2_decades) t
      )
      SELECT 
        d.decade,
        COALESCE(u1.count, 0) AS user1_count,
        COALESCE(u2.count, 0) AS user2_count
      FROM 
        all_decades d
      LEFT JOIN 
        user1_decades u1 ON d.decade = u1.decade
      LEFT JOIN 
        user2_decades u2 ON d.decade = u2.decade
      ORDER BY 
        d.decade
    `;
    
    const yearsResult = await db.query(yearQuery, [user1Id, user2Id]);
    const decades = yearsResult.rows;
    
    // Normalize decade preferences and calculate similarity
    const user1YearTotal = decades.reduce((sum, d) => sum + parseInt(d.user1_count || 0), 0) || 1;
    const user2YearTotal = decades.reduce((sum, d) => sum + parseInt(d.user2_count || 0), 0) || 1;
    
    const user1YearVector = decades.map(d => parseInt(d.user1_count || 0) / user1YearTotal);
    const user2YearVector = decades.map(d => parseInt(d.user2_count || 0) / user2YearTotal);
    
    // Calculate cosine similarity for decades
    dotProduct = 0;
    magnitude1 = 0;
    magnitude2 = 0;
    
    for (let i = 0; i < decades.length; i++) {
      dotProduct += user1YearVector[i] * user2YearVector[i];
      magnitude1 += user1YearVector[i] * user1YearVector[i];
      magnitude2 += user2YearVector[i] * user2YearVector[i];
    }
    
    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);
    
    let yearScore = 0;
    if (magnitude1 > 0 && magnitude2 > 0) {
      const cosineSimilarity = dotProduct / (magnitude1 * magnitude2);
      yearScore = cosineSimilarity * 10;
    }
    
    totalScore += yearScore;
    maxPossibleScore += 10;
    
    // Calculate final normalized score
    let finalScore = maxPossibleScore > 0 ? (totalScore / maxPossibleScore) * 100 : 0;
    
    // Store match score in database
    await this.storeMatchScore(user1Id, user2Id, finalScore);
    
    return finalScore;
  }
  
  /**
   * Store match score in database
   * 
   * @param {string} user1Id - First user ID
   * @param {string} user2Id - Second user ID
   * @param {number} score - Match score
   * @returns {Promise<void>}
   */
  static async storeMatchScore(user1Id, user2Id, score) {
    // Ensure consistent order of user IDs
    const [smallerId, largerId] = user1Id < user2Id ? [user1Id, user2Id] : [user2Id, user1Id];
    
    const query = `
      INSERT INTO matches (
        match_id, user_id_1, user_id_2, match_score, status, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, 'pending', NOW(), NOW()
      )
      ON CONFLICT (user_id_1, user_id_2)
      DO UPDATE SET
        match_score = $4,
        updated_at = NOW()
    `;
    
    const matchId = uuidv4();
    await db.query(query, [matchId, smallerId, largerId, score]);
  }
  
  /**
   * Get match status between two users
   * 
   * @param {string} user1Id - First user ID
   * @param {string} user2Id - Second user ID
   * @returns {Promise<Object|null>} Match object or null if not found
   */
  static async getMatchStatus(user1Id, user2Id) {
    // Ensure consistent order of user IDs
    const [smallerId, largerId] = user1Id < user2Id ? [user1Id, user2Id] : [user2Id, user1Id];
    
    const query = `
      SELECT 
        match_id, user_id_1, user_id_2, match_score, status, 
        created_at, updated_at
      FROM matches
      WHERE user_id_1 = $1 AND user_id_2 = $2
    `;
    
    const result = await db.query(query, [smallerId, largerId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.formatMatch(result.rows[0]);
  }
  
  /**
   * Update match status
   * 
   * @param {string} matchId - Match ID
   * @param {string} userId - User ID updating the status
   * @param {string} status - New status ('liked', 'passed', 'matched')
   * @returns {Promise<Object>} Updated match object
   */
  static async updateStatus(matchId, userId, status) {
    // Verify user is part of this match
    const matchQuery = `
      SELECT match_id, user_id_1, user_id_2, status
      FROM matches
      WHERE match_id = $1 AND (user_id_1 = $2 OR user_id_2 = $2)
    `;
    
    const matchResult = await db.query(matchQuery, [matchId, userId]);
    
    if (matchResult.rows.length === 0) {
      throw new Error('Match not found or user not part of match');
    }
    
    const match = matchResult.rows[0];
    const otherUserId = match.user_id_1 === userId ? match.user_id_2 : match.user_id_1;
    
    // Determine actual status based on both users' actions
    let newStatus = status;
    
    if (status === 'liked') {
      // Check if other user has already liked
      const otherUserActionQuery = `
        SELECT status
        FROM user_match_actions
        WHERE match_id = $1 AND user_id = $2
      `;
      
      const otherUserResult = await db.query(otherUserActionQuery, [matchId, otherUserId]);
      
      if (otherUserResult.rows.length > 0 && otherUserResult.rows[0].status === 'liked') {
        newStatus = 'matched'; // Both users liked each other
      }
    }
    
    // Update user's action for this match
    const actionQuery = `
      INSERT INTO user_match_actions (
        action_id, match_id, user_id, status, created_at
      )
      VALUES (
        $1, $2, $3, $4, NOW()
      )
      ON CONFLICT (match_id, user_id)
      DO UPDATE SET
        status = $4,
        updated_at = NOW()
    `;
    
    const actionId = uuidv4();
    await db.query(actionQuery, [actionId, matchId, userId, status]);
    
    // Update match status if needed
    if (newStatus === 'matched') {
      const updateQuery = `
        UPDATE matches
        SET status = 'matched', updated_at = NOW()
        WHERE match_id = $1
        RETURNING match_id, user_id_1, user_id_2, match_score, status, created_at, updated_at
      `;
      
      const updateResult = await db.query(updateQuery, [matchId]);
      
      // Create conversation for matched users
      await this.createConversation(matchId);
      
      return this.formatMatch(updateResult.rows[0]);
    }
    
    // Return current match
    const currentMatchQuery = `
      SELECT match_id, user_id_1, user_id_2, match_score, status, created_at, updated_at
      FROM matches
      WHERE match_id = $1
    `;
    
    const currentMatchResult = await db.query(currentMatchQuery, [matchId]);
    
    return this.formatMatch(currentMatchResult.rows[0]);
  }
  
  /**
   * Create a conversation for a matched pair
   * 
   * @param {string} matchId - Match ID
   * @returns {Promise<Object>} Created conversation
   */
  static async createConversation(matchId) {
    const query = `
      INSERT INTO conversations (
        conversation_id, match_id, created_at, last_message_at
      )
      VALUES (
        $1, $2, NOW(), NULL
      )
      RETURNING conversation_id
    `;
    
    const conversationId = uuidv4();
    const result = await db.query(query, [conversationId, matchId]);
    
    return {
      id: result.rows[0].conversation_id,
      matchId
    };
  }
  
  /**
   * Get user's matches
   * 
   * @param {string} userId - User ID
   * @param {string} [status='matched'] - Match status to filter by
   * @param {Object} options - Query options
   * @param {number} [options.limit=50] - Maximum number of results
   * @param {number} [options.offset=0] - Result offset for pagination
   * @returns {Promise<Array<Object>>} User's matches with details
   */
  static async getUserMatches(userId, status = 'matched', { limit = 50, offset = 0 } = {}) {
    const query = `
      SELECT 
        m.match_id, m.user_id_1, m.user_id_2, m.match_score, m.status,
        m.created_at, m.updated_at,
        u.user_id, u.username, u.first_name, u.last_name,
        u.profile_picture_url, u.gender,
        EXTRACT(YEAR FROM AGE(CURRENT_DATE, u.birth_date)) as age
      FROM matches m
      JOIN users u ON (
        CASE 
          WHEN m.user_id_1 = $1 THEN m.user_id_2
          ELSE m.user_id_1
        END = u.user_id
      )
      WHERE 
        (m.user_id_1 = $1 OR m.user_id_2 = $1)
        AND m.status = $2
      ORDER BY 
        m.updated_at DESC
      LIMIT $3 OFFSET $4
    `;
    
    const result = await db.query(query, [userId, status, limit, offset]);
    
    return result.rows.map(row => ({
      ...this.formatMatch(row),
      otherUser: {
        id: row.user_id,
        username: row.username,
        firstName: row.first_name,
        lastName: row.last_name,
        profilePicture: row.profile_picture_url,
        gender: row.gender,
        age: parseInt(row.age)
      }
    }));
  }
  
  /**
   * Queue users for match recalculation
   * 
   * @param {string} userId - User ID that triggered recalculation
   * @returns {Promise<void>}
   */
  static async queueForRecalculation(userId) {
    // Add to Redis set of users needing match recalculation
    await asyncRedis.sadd('match:recalculate', userId);
    
    // Set expiration to ensure we don't keep users in the queue forever
    await asyncRedis.expire('match:recalculate', 86400); // 24 hours
  }
  
  /**
   * Format match object for external use
   * 
   * @param {Object} match - Raw match object from database
   * @returns {Object} Formatted match object
   */
  static formatMatch(match) {
    if (!match) return null;
    
    return {
      id: match.match_id,
      user1Id: match.user_id_1,
      user2Id: match.user_id_2,
      score: parseFloat(match.match_score),
      status: match.status,
      createdAt: match.created_at,
      updatedAt: match.updated_at
    };
  }
}

module.exports = Match;