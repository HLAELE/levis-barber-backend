const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config();

const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'levis_fis',
    port: parseInt(process.env.DB_PORT || '3306'),
    ssl: { rejectUnauthorized: false }
});

const promiseDb = db.promise();

async function checkAndHashPasswords() {
    try {
        console.log('Connecting to database...');
        const [users] = await promiseDb.query('SELECT user_id, username, password, role FROM users');
        console.log(`Found ${users.length} users in database.`);
        
        for (const user of users) {
            const isHashed = user.password.startsWith('$2a$') || user.password.startsWith('$2b$');
            console.log(`User: ${user.username}, Role: ${user.role}, Password is hashed: ${isHashed}`);
            
            if (!isHashed) {
                console.log(`Hashing password for user: ${user.username}...`);
                const hashedPassword = await bcrypt.hash(user.password, 10);
                await promiseDb.query('UPDATE users SET password = ? WHERE user_id = ?', [hashedPassword, user.user_id]);
                console.log(`Updated user ${user.username} with hashed password.`);
            }
        }
        console.log('Done!');
    } catch (err) {
        console.error('Error:', err);
    } finally {
        db.end();
    }
}

checkAndHashPasswords();
