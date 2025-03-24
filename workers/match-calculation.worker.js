// workers/match-calculation.worker.js
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const { asyncRedis } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
// PostgreSQL connection
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'musicapp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync(path.resolve(__dirname, "./ca.pem")).toString(),
  },
});

// Create worker to process match recalculations
const matchCalculationWorker = new Worker('match-calculation-queue', async (job) => {
  const { triggerUserId } = job.data;
  
  console.log(`Processing match recalculations, triggered by user ${triggerUserId}`);
  
  try {
    // Get users needing match recalculation from Redis
    const userIds = await asyncRedis.smembers('match:recalculate');
    
    if (!userIds || userIds.length === 0) {
      console.log('No users need match recalculation');
      return { success: true, processed: 0 };
    }
    
    console.log(`Processing match recalculations for ${userIds.length} users`);
    
    // Process in batches to avoid overwhelming the database
    const batchSize = 5;
    const batches = Math.ceil(userIds.length / batchSize);
    let totalProcessed = 0;
    
    for (let i = 0; i < batches; i++) {
      const batchStart = i * batchSize;
      const batchEnd = Math.min((i + 1) * batchSize, userIds.length);
      const batch = userIds.slice(batchStart, batchEnd);
      
      console.log(`Processing batch ${i + 1}/${batches}, users: ${batch.join(', ')}`);
      
      for (const userId of batch) {
        // Find potential matches to calculate scores for
        const potentialMatchesQuery = `
          WITH user_prefs AS (
            SELECT 
              preferred_gender, min_age, max_age, max_distance
            FROM 
              user_preferences
            WHERE 
              user_id = $1
          ),
          user_location AS (
            SELECT 
              latitude, longitude
            FROM 
              user_locations
            WHERE 
              user_id = $1
          )
          SELECT 
            u.user_id,
            (
              6371 * acos(
                cos(radians(ul.latitude)) * 
                cos(radians(ul2.latitude)) * 
                cos(radians(ul2.longitude) - radians(ul.longitude)) + 
                sin(radians(ul.latitude)) * 
                sin(radians(ul2.latitude))
              )
            ) as distance
          FROM 
            users u
          JOIN 
            user_locations ul2 ON u.user_id = ul2.user_id
          JOIN 
            user_preferences up ON u.user_id = up.user_id
          CROSS JOIN 
            user_location ul
          CROSS JOIN 
            user_prefs up2
          WHERE 
            u.user_id != $1
            AND up.is_visible = TRUE
            AND (up2.preferred_gender IS NULL OR u.gender = up2.preferred_gender)
            AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, u.birth_date)) BETWEEN 
              COALESCE(up2.min_age, 18) AND COALESCE(up2.max_age, 100)
            AND (
              6371 * acos(
                cos(radians(ul.latitude)) * 
                cos(radians(ul2.latitude)) * 
                cos(radians(ul2.longitude) - radians(ul.longitude)) + 
                sin(radians(ul.latitude)) * 
                sin(radians(ul2.latitude))
              )
            ) <= COALESCE(up2.max_distance, 100)
          LIMIT 50 -- Limit to 50 potential matches to avoid overload
        `;
        
        try {
          const potentialMatches = await pool.query(potentialMatchesQuery, [userId]);
          
          console.log(`Found ${potentialMatches.rows.length} potential matches for user ${userId}`);
          
          for (const match of potentialMatches.rows) {
            try {
              // Calculate match score
              const matchScore = await calculateMatchScore(userId, match.user_id);
              
              // Store match score
              await storeMatchScore(userId, match.user_id, matchScore);
              
              // Cache match score in Redis
              const smallerId = userId < match.user_id ? userId : match.user_id;
              const largerId = userId < match.user_id ? match.user_id : userId;
              const scoreKey = `match:score:${smallerId}:${largerId}`;
              await asyncRedis.set(scoreKey, matchScore.toString(), 'EX', 86400); // 24-hour expiry
              
              totalProcessed++;
            } catch (scoreError) {
              console.error(`Error calculating score between ${userId} and ${match.user_id}:`, scoreError);
              // Continue with next match
            }
          }
          
          // Remove user from Redis set after processing
          await asyncRedis.srem('match:recalculate', userId);
        } catch (userError) {
          console.error(`Error processing matches for user ${userId}:`, userError);
          // Continue with next user
        }
      }
    }
    
    console.log(`Completed match recalculations, processed ${totalProcessed} matches`);
    
    return { success: true, processed: totalProcessed };
    
  } catch (error) {
    console.error('Error processing match calculations:', error);
    throw error;
  }
}, {
  connection: {
    url: process.env.REDIS_URL
  },
  concurrency: 1 // Only one match calculation job at a time
});

// Calculate match score between two users
async function calculateMatchScore(user1Id, user2Id) {
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
    pool.query(songQuery, [user1Id, user2Id]),
    pool.query(user1SongsQuery, [user1Id]),
    pool.query(user2SongsQuery, [user2Id])
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
  
  const commonArtistsResult = await pool.query(artistQuery, [user1Id, user2Id]);
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
  
  const genresResult = await pool.query(genreQuery, [user1Id, user2Id]);
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
    ORDER BY h.hour
  `;
  
  const patternsResult = await pool.query(patternQuery, [user1Id, user2Id]);
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
  
  const yearsResult = await pool.query(yearQuery, [user1Id, user2Id]);
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
  
  return Math.round(finalScore * 10) / 10; // Round to 1 decimal place
}

// Store match score in database
async function storeMatchScore(user1Id, user2Id, score) {
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
  
  await pool.query(query, [uuidv4(), smallerId, largerId, score]);
}

// Handle worker events
matchCalculationWorker.on('completed', job => {
  console.log(`Job ${job.id} completed successfully`);
});

matchCalculationWorker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed with error:`, err);
});

console.log('Match calculation worker started');