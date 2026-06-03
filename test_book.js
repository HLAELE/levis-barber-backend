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

async function simulateBooking() {
    console.log('Finding a customer in database...');
    const [customers] = await promiseDb.query('SELECT user_id, customer_id, full_name FROM customers LIMIT 1');
    if (customers.length === 0) {
        console.log('No customers found in database!');
        return;
    }
    const customer = customers[0];
    console.log('Using customer:', customer);

    console.log('Finding approved barbers...');
    const [barbers] = await promiseDb.query(`
        SELECT e.employee_id, e.full_name FROM employees e 
        JOIN users u ON e.user_id = u.user_id 
        WHERE u.is_approved = 1 LIMIT 1
    `);
    if (barbers.length === 0) {
        console.log('No approved barbers found! Approving mosa hlaele (user_id = 2) first...');
        // Approve mosa hlaele (user_id = 2) for the test
        await promiseDb.query('UPDATE users SET is_approved = 1 WHERE user_id = 2');
        // Check if employees has mosa hlaele, if not insert
        const [emp] = await promiseDb.query('SELECT employee_id FROM employees WHERE user_id = 2');
        if (emp.length === 0) {
            await promiseDb.query(
                "INSERT INTO employees (full_name, position, salary, hire_date, user_id) VALUES ('mosa hlaele', 'Barber', 0, CURDATE(), 2)"
            );
        }
        // Query again
        const [barbersNew] = await promiseDb.query(`
            SELECT e.employee_id, e.full_name FROM employees e 
            JOIN users u ON e.user_id = u.user_id 
            WHERE u.is_approved = 1 LIMIT 1
        `);
        console.log('Barber after approval:', barbersNew[0]);
    } else {
        console.log('Using barber:', barbers[0]);
    }
    
    // Query again to get the barber ID to insert
    const [activeBarbers] = await promiseDb.query(`
        SELECT e.employee_id FROM employees e 
        JOIN users u ON e.user_id = u.user_id 
        WHERE u.is_approved = 1 LIMIT 1
    `);
    const barberId = activeBarbers[0].employee_id;
    
    try {
        console.log('Attempting to insert appointment...');
        const custom_service = 'low fade with line-up';
        const appointment_date = '2026-06-05';
        const appointment_time = '10:00';
        const amount = 150.00;
        const payment_method = 'CASH';
        
        const [appointment] = await promiseDb.query(
            "INSERT INTO appointments (customer_id, employee_id, notes, appointment_date, time_slot, status) VALUES (?, ?, ?, ?, ?, 'PENDING')",
            [customer.customer_id, barberId, custom_service, appointment_date, appointment_time]
        );
        console.log('✅ Appointment inserted, ID:', appointment.insertId);
        
        console.log('Attempting to insert payment...');
        await promiseDb.query(
            'INSERT INTO payments (appointment_id, amount, payment_method, payment_date) VALUES (?, ?, ?, ?)', 
            [appointment.insertId, amount, payment_method, appointment_date]
        );
        console.log('✅ Payment inserted!');
        
        // Clean up
        console.log('Cleaning up simulation data...');
        await promiseDb.query('DELETE FROM payments WHERE appointment_id = ?', [appointment.insertId]);
        await promiseDb.query('DELETE FROM appointments WHERE appointment_id = ?', [appointment.insertId]);
        console.log('✅ Clean up complete.');
    } catch (err) {
        console.error('❌ Simulation failed:', err);
    } finally {
        db.end();
    }
}

simulateBooking();
