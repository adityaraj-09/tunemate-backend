// config/database.js
const { Pool } = require('pg');
const fs = require('fs');

const path = require('path');

/**
 * PostgreSQL connection pool
 * Uses environment variables for configuration or falls back to defaults
 */
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'musicapp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
  // Additional PostgreSQL connection options
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 10000, // How long to wait for a connection
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync(path.resolve(__dirname, "./ca.pem")).toString(),
  },
});

// Error handling for the pool
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/**
 * Execute a query with automatic connection management
 * 
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
const query = async (text, params) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  
  // Log queries taking longer than 200ms
  if (duration > 200) {
    console.log('Long query:', { text, duration, rows: res.rowCount });
  }
  
  return res;
};

/**
 * Get a client from the pool with transaction support
 * 
 * @returns {Promise<Object>} Client with begin, commit, and rollback methods
 */
const getClient = async () => {
  const client = await pool.connect();
  const originalRelease = client.release;
  
  // Set a timeout of 5 seconds to release back to pool
  const timeout = setTimeout(() => {
    console.error('A client has been checked out for too long!');
    console.error(`The last executed query was: ${client.lastQuery}`);
  }, 5000);
  
  // Monkey patch the release method
  client.release = () => {
    clearTimeout(timeout);
    // Reset the release method to its original
    client.release = originalRelease;
    return client.release();
  };
  
  return client;
};

/**
 * Run a transaction
 * 
 * @param {Function} callback - Function that will receive client and execute queries
 * @returns {Promise<any>} Result of callback
 */
const transaction = async (callback) => {
  const client = await getClient();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

module.exports = {
  pool,
  query,
  getClient,
  transaction
};