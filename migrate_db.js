const mysql = require('mysql2');
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

async function runMigration() {
    try {
        console.log('Running database migrations...');
        
        // 1. Add PENDING to status enum
        console.log('Altering appointments status enum...');
        await promiseDb.query(`
            ALTER TABLE appointments 
            MODIFY COLUMN status ENUM('PENDING', 'SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW') 
            DEFAULT 'PENDING'
        `);
        console.log('Successfully altered appointments table status ENUM.');
        
        // 2. Update existing 'SCHEDULED' appointments to 'PENDING'
        console.log('Updating existing SCHEDULED appointments to PENDING...');
        const [result] = await promiseDb.query("UPDATE appointments SET status = 'PENDING' WHERE status = 'SCHEDULED'");
        console.log(`Updated ${result.affectedRows} appointments to PENDING.`);

        // 3. Create salaries table if it doesn't exist
        console.log('Creating salaries table if it doesn\'t exist...');
        await promiseDb.query(`
            CREATE TABLE IF NOT EXISTS \`salaries\` (
              \`salary_id\` int NOT NULL AUTO_INCREMENT,
              \`employee_id\` int NOT NULL,
              \`month\` int NOT NULL,
              \`year\` int NOT NULL,
              \`amount\` decimal(10, 2) NOT NULL,
              \`paid_date\` date,
              \`created_at\` timestamp DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (\`salary_id\`),
              FOREIGN KEY (\`employee_id\`) REFERENCES \`employees\`(\`employee_id\`) ON DELETE CASCADE,
              UNIQUE KEY \`unique_month_year_employee\` (\`employee_id\`, \`month\`, \`year\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('Successfully created/verified salaries table.');
        
        console.log('Database migration complete!');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        db.end();
    }
}

runMigration();
