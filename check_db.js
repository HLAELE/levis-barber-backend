const mysql = require('mysql2');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'HLAELEmosa@09092001',
    database: process.env.DB_NAME || 'levis_fis'
});

const promisePool = pool.promise();

async function main() {
    try {
        const [tables] = await promisePool.query('SHOW TABLES');
        console.log('Tables found in database:', tables);
        for (const row of tables) {
            const tableName = Object.values(row)[0];
            const [desc] = await promisePool.query(`DESCRIBE \`${tableName}\``);
            console.log(`\nTable: ${tableName}`);
            console.table(desc);
        }
    } catch (err) {
        console.error('Error connecting/querying database:', err);
    } finally {
        pool.end();
    }
}

main();
