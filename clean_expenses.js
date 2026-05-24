const mysql = require('mysql2');
const dotenv = require('dotenv');
dotenv.config();

const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'HLAELEmosa@09092001',
    database: process.env.DB_NAME || 'levis_fis',
});

db.query('DELETE FROM expenses WHERE category NOT IN ("Salary", "Equipment")', (err, results) => {
    if (err) {
        console.error('Error deleting expenses:', err);
    } else {
        console.log(`✅ Cleaned up database! Removed ${results.affectedRows} unwanted expenses.`);
    }
    process.exit(0);
});
