const mysql = require('mysql2');
const pool = mysql.createPool({host: 'localhost', user: 'root', password: 'HLAELEmosa@09092001', database: 'levis_fis'});
pool.query('DESCRIBE payments', (err, results) => {
    console.log(results);
    process.exit(0);
});
