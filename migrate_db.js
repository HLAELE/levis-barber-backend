const mysql = require('mysql2');
const dotenv = require('dotenv');

dotenv.config();

const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'levis_fis',
    port: parseInt(process.env.DB_PORT || '3306'),
    ssl: (process.env.DB_HOST || '').includes('aivencloud') ? { rejectUnauthorized: false } : false
});

const promiseDb = db.promise();

async function runMigration() {
    try {
        console.log('Running database migrations...');
        
        // 1. Expand status enum to include all booking workflow statuses
        console.log('1. Expanding appointments status enum...');
        await promiseDb.query(`
            ALTER TABLE appointments 
            MODIFY COLUMN status ENUM('PENDING', 'SCHEDULED', 'APPROVED', 'DECLINED', 'RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW') 
            DEFAULT 'PENDING'
        `);
        console.log('   ✅ Status enum expanded.');
        
        // 2. Update existing 'SCHEDULED' appointments to 'PENDING'
        console.log('2. Updating existing SCHEDULED appointments to PENDING...');
        const [result] = await promiseDb.query("UPDATE appointments SET status = 'PENDING' WHERE status = 'SCHEDULED'");
        console.log(`   ✅ Updated ${result.affectedRows} appointments to PENDING.`);

        // 3. Add appointment_time column if it doesn't exist
        console.log('3. Adding appointment_time column...');
        try {
            await promiseDb.query(`
                ALTER TABLE appointments ADD COLUMN appointment_time VARCHAR(10) AFTER appointment_date
            `);
            console.log('   ✅ appointment_time column added.');
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log('   ⏭️  appointment_time column already exists, skipping.');
            } else {
                throw err;
            }
        }

        // 4. Add actioned_by column to track which employee approved/declined/rescheduled
        console.log('4. Adding actioned_by column...');
        try {
            await promiseDb.query(`
                ALTER TABLE appointments ADD COLUMN actioned_by INT NULL AFTER status
            `);
            console.log('   ✅ actioned_by column added.');
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log('   ⏭️  actioned_by column already exists, skipping.');
            } else {
                throw err;
            }
        }

        // 5. Add actioned_at timestamp column
        console.log('5. Adding actioned_at column...');
        try {
            await promiseDb.query(`
                ALTER TABLE appointments ADD COLUMN actioned_at TIMESTAMP NULL AFTER actioned_by
            `);
            console.log('   ✅ actioned_at column added.');
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log('   ⏭️  actioned_at column already exists, skipping.');
            } else {
                throw err;
            }
        }

        // 6. Create salaries table if it doesn't exist
        console.log('6. Creating salaries table if it doesn\'t exist...');
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
        console.log('   ✅ Salaries table verified.');
        
        console.log('\n🎉 Database migration complete!');
    } catch (err) {
        console.error('❌ Migration failed:', err);
    } finally {
        db.end();
    }
}

runMigration();
