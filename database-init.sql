-- Create users table
CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(50),
    last_name VARCHAR(50),
    birth_date DATE,
    gender VARCHAR(20),
    profile_picture_url VARCHAR(255),
    bio TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Playlists table
CREATE TABLE IF NOT EXISTS playlists (
    playlist_id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    image_url VARCHAR(255),
    created_by UUID REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create a playlist_songs junction table for many-to-many relationship
CREATE TABLE IF NOT EXISTS playlist_songs (
    playlist_id UUID REFERENCES playlists(playlist_id) ON DELETE CASCADE,
    song_id VARCHAR(36) NOT NULL, -- Assuming this is your song ID format
    position INTEGER NOT NULL, -- For maintaining song order in playlist
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (playlist_id, song_id)
);

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_playlists_created_by ON playlists(created_by);
CREATE INDEX IF NOT EXISTS idx_playlist_songs_song_id ON playlist_songs(song_id);
CREATE INDEX IF NOT EXISTS idx_playlist_songs_position ON playlist_songs(playlist_id, position);

-- Add trigger to update the updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = CURRENT_TIMESTAMP;
   RETURN NEW;
END;
$$ language 'plpgsql';



CREATE TABLE IF NOT EXISTS user_locations (
    location_id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(user_id),
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100),
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- Create user_preferences table
CREATE TABLE IF NOT EXISTS user_preferences (
    preference_id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(user_id),
    preferred_gender VARCHAR(50),
    min_age INTEGER,
    max_age INTEGER,
    max_distance INTEGER,
    is_visible BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- Create songs table
CREATE TABLE IF NOT EXISTS songs (
    song_id VARCHAR(36) PRIMARY KEY,
    song_name VARCHAR(255) NOT NULL,
    album VARCHAR(255),
    primary_artists VARCHAR(255),
    singers VARCHAR(255),
    image_url VARCHAR(255),
    media_url VARCHAR(255) NOT NULL,
    lyrics TEXT,
    duration VARCHAR(10),
    release_year VARCHAR(4),
    language VARCHAR(50),
    copyright_text TEXT,
    genre VARCHAR(50),
    album_url VARCHAR(255)
);

-- Create user_music_history table
CREATE TABLE IF NOT EXISTS user_music_history (
    history_id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(user_id),
    song_id VARCHAR(36) REFERENCES songs(song_id),
    play_count INTEGER DEFAULT 1,
    last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_favorite BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, song_id)
);

-- Create user_music_preferences table
CREATE TABLE IF NOT EXISTS user_music_preferences (
    preference_id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(user_id),
    genre VARCHAR(100),
    artist VARCHAR(100),
    language VARCHAR(100),
    preference_weight DECIMAL(5, 2) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, genre),
    UNIQUE(user_id, artist)
);

-- Create matches table
CREATE TABLE IF NOT EXISTS matches (
    match_id UUID PRIMARY KEY,
    user_id_1 UUID REFERENCES users(user_id),
    user_id_2 UUID REFERENCES users(user_id),
    match_score DECIMAL(5, 2),
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id_1, user_id_2)
);

-- Create user_match_actions table
CREATE TABLE IF NOT EXISTS user_match_actions (
    action_id UUID PRIMARY KEY,
    match_id UUID REFERENCES matches(match_id),
    user_id UUID REFERENCES users(user_id),
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(match_id, user_id)
);

-- Create conversations table
CREATE TABLE IF NOT EXISTS conversations (
    conversation_id UUID PRIMARY KEY,
    match_id UUID REFERENCES matches(match_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP
);

-- Create messages table
CREATE TABLE IF NOT EXISTS messages (
    message_id UUID PRIMARY KEY,
    conversation_id UUID REFERENCES conversations(conversation_id),
    sender_id UUID REFERENCES users(user_id),
    message_text TEXT,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_read BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    attachment_url VARCHAR(255)
);

-- Create shared_songs table
CREATE TABLE IF NOT EXISTS shared_songs (
    shared_id UUID PRIMARY KEY,
    message_id UUID REFERENCES messages(message_id),
    song_id VARCHAR(36) REFERENCES songs(song_id),
    shared_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create user_conversation_status table
CREATE TABLE IF NOT EXISTS user_conversation_status (
    status_id UUID PRIMARY KEY,
    conversation_id UUID REFERENCES conversations(conversation_id),
    user_id UUID REFERENCES users(user_id),
    is_archived BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id, user_id)
);

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
    notification_id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(user_id),
    notification_type VARCHAR(50),
    content TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create push_subscriptions table
CREATE TABLE IF NOT EXISTS push_subscriptions (
    subscription_id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(user_id),
    subscription_data TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for frequently queried columns
CREATE INDEX IF NOT EXISTS idx_user_music_history_user_id ON user_music_history(user_id);
CREATE INDEX IF NOT EXISTS idx_user_music_history_song_id ON user_music_history(song_id);
CREATE INDEX IF NOT EXISTS idx_user_music_preferences_user_id ON user_music_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_matches_user_ids ON matches(user_id_1, user_id_2);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);

-- -- Index for the date filter with song_id for covered queries
-- CREATE INDEX idx_user_music_history_last_played_song_id ON user_music_history(last_played, song_id);

-- -- Composite index for commonly queried fields
-- CREATE INDEX idx_user_music_history_user_song_date ON user_music_history(user_id, song_id, last_played);

-- DO $$
-- BEGIN
--   IF NOT EXISTS (
--     SELECT FROM information_schema.columns 
--     WHERE table_name = 'songs' AND column_name = 'album_url'
--   ) THEN
--     ALTER TABLE songs ADD COLUMN album_url VARCHAR(255);
--   END IF;
-- END
-- $$;