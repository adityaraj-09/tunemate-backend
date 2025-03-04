// database-init.js
const { pool } = require('./config/database');
const fs = require('fs');
const path = require('path');

async function initializeDatabase() {
  try {
    console.log('Initializing database schema...');
    
    // Read SQL file
    const sqlFilePath = path.join(__dirname, 'database-init.sql');
    const sqlScript = fs.readFileSync(sqlFilePath, 'utf8');
    
    // Execute SQL script
    await pool.query(sqlScript);
    
    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Error initializing database schema:', error);
    throw error;
  }
}

module.exports = { initializeDatabase };