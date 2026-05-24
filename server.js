const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// MySQL connection pool
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'HLAELEmosa@09092001',
    database: process.env.DB_NAME || 'levis_fis',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const promiseDb = db.promise();

console.log('✅ Database connection pool created');

// ============ MIDDLEWARE ============
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'levis_barber_secret_key_2026');
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid or expired token.' });
    }
};

const authorizeRoles = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
        }
        next();
    };
};

// ============ AUTH ENDPOINTS ============

// Register
app.post('/api/auth/register', async (req, res) => {
    const { full_name, username, password, role, phone, email } = req.body;

    if (!full_name || !username || !password) {
        return res.status(400).json({ error: 'Full name, username and password are required' });
    }

    try {
        const [existing] = await promiseDb.query('SELECT user_id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Username already exists' });
        }

        let isApproved = 1;
        if (role === 'EMPLOYEE') {
            isApproved = 0;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await promiseDb.query(
            'INSERT INTO users (full_name, username, password, role, is_approved) VALUES (?, ?, ?, ?, ?)',
            [full_name, username, hashedPassword, role || 'CUSTOMER', isApproved]
        );

        const userId = result.insertId;

        if (role === 'CUSTOMER') {
            await promiseDb.query(
                'INSERT INTO customers (full_name, phone, email, user_id) VALUES (?, ?, ?, ?)',
                [full_name, phone || null, email || null, userId]
            );
        }

        res.status(201).json({ 
            success: true, 
            message: role === 'EMPLOYEE' ? 'Registration successful. Awaiting owner approval.' : 'Registration successful.'
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    try {
        const [users] = await promiseDb.query(
            'SELECT user_id, full_name, username, password, role, is_approved FROM users WHERE username = ?',
            [username]
        );

        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = users[0];

        if (user.role === 'EMPLOYEE' && user.is_approved === 0) {
            return res.status(401).json({ error: 'Account pending owner approval' });
        }

        let validPassword = false;
        if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
            validPassword = await bcrypt.compare(password, user.password);
        } else {
            validPassword = (password === user.password);
        }
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { 
                userId: user.user_id, 
                username: user.username, 
                role: user.role,
                full_name: user.full_name
            },
            process.env.JWT_SECRET || 'levis_barber_secret_key_2026',
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            token,
            user: {
                userId: user.user_id,
                full_name: user.full_name,
                username: user.username,
                role: user.role
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Test endpoint
app.get('/api/test/users', async (req, res) => {
    try {
        const [users] = await promiseDb.query('SELECT user_id, full_name, username, password, role, is_approved FROM users');
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ OWNER ENDPOINTS ============

app.get('/api/owner/dashboard', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [revenueResult] = await promiseDb.query('SELECT (SELECT COALESCE(SUM(amount),0) FROM payments) + (SELECT COALESCE(SUM(amount),0) FROM other_income) as total');
        const [expensesResult] = await promiseDb.query('SELECT SUM(amount) as total FROM expenses');
        const [customersResult] = await promiseDb.query('SELECT COUNT(*) as count FROM customers');
        
        res.json({
            totalRevenue: revenueResult[0].total || 0,
            totalExpenses: expensesResult[0].total || 0,
            netProfit: (revenueResult[0].total || 0) - (expensesResult[0].total || 0),
            totalCustomers: customersResult[0].count || 0
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
});

app.get('/api/owner/pending-employees', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [employees] = await promiseDb.query(`
            SELECT user_id, full_name, username, created_at 
            FROM users 
            WHERE role = 'EMPLOYEE' AND is_approved = 0
            ORDER BY created_at ASC
        `);
        res.json(employees);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pending employees' });
    }
});

app.post('/api/owner/approve-employee/:userId', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { userId } = req.params;
    const { position, salary, phone, hire_date } = req.body;

    try {
        const [users] = await promiseDb.query('SELECT full_name FROM users WHERE user_id = ? AND role = "EMPLOYEE"', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        await promiseDb.query('UPDATE users SET is_approved = 1 WHERE user_id = ?', [userId]);
        await promiseDb.query(
            'INSERT INTO employees (full_name, phone, position, salary, hire_date, user_id) VALUES (?, ?, ?, ?, ?, ?)',
            [users[0].full_name, phone || null, position || 'Barber', salary || 0, hire_date || new Date(), userId]
        );

        res.json({ success: true, message: 'Employee approved successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to approve employee' });
    }
});

// Reject employee
app.delete('/api/owner/reject-employee/:userId', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { userId } = req.params;

    try {
        const [users] = await promiseDb.query('SELECT user_id FROM users WHERE user_id = ? AND role = "EMPLOYEE" AND is_approved = 0', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'Pending employee not found' });
        }

        await promiseDb.query('DELETE FROM users WHERE user_id = ?', [userId]);
        
        res.json({ success: true, message: 'Employee registration rejected' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to reject employee' });
    }
});

app.get('/api/owner/employees', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [employees] = await promiseDb.query(`
            SELECT e.*, u.username, u.is_approved
            FROM employees e
            JOIN users u ON e.user_id = u.user_id
            ORDER BY e.employee_id ASC
        `);
        res.json(employees);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch employees' });
    }
});

app.post('/api/owner/pay-salary', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { employee_id, amount, description } = req.body;

    if (!employee_id || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Valid employee ID and amount required' });
    }

    try {
        const [employees] = await promiseDb.query('SELECT full_name FROM employees WHERE employee_id = ?', [employee_id]);
        if (employees.length === 0) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        await promiseDb.query('UPDATE employees SET salary = ? WHERE employee_id = ?', [amount, employee_id]);
        await promiseDb.query(
            'INSERT INTO expenses (description, amount, category, expense_date) VALUES (?, ?, ?, CURDATE())',
            [description || `Salary payment to ${employees[0].full_name}`, amount, 'Salary']
        );

        res.json({ success: true, message: 'Salary paid and recorded as expense' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to process salary payment' });
    }
});

app.post('/api/owner/add-expense', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { amount, description, category } = req.body;
    if (!amount || amount <= 0 || !category) {
        return res.status(400).json({ error: 'Valid amount and category required' });
    }
    try {
        await promiseDb.query(
            'INSERT INTO expenses (description, amount, category, expense_date) VALUES (?, ?, ?, CURDATE())',
            [description || `Added ${category} expense`, amount, category]
        );
        res.json({ success: true, message: 'Expense added successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add expense' });
    }
});

app.get('/api/owner/income', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        // Customer payments
        const [payments] = await promiseDb.query(`
            SELECT 
                p.payment_id as id,
                c.full_name as source,
                a.appointment_id,
                p.amount,
                p.payment_method,
                p.payment_date as income_date,
                'Customer Payment' as source_type
            FROM payments p
            JOIN appointments a ON p.appointment_id = a.appointment_id
            JOIN customers c ON a.customer_id = c.customer_id
        `);

        // Other income
        const [otherIncome] = await promiseDb.query(`
            SELECT 
                oi.income_id as id,
                oi.source,
                NULL as appointment_id,
                oi.amount,
                oi.payment_method,
                oi.income_date,
                oi.category as source_type
            FROM other_income oi
        `);

        const combined = [...payments, ...otherIncome]
            .sort((a, b) => new Date(b.income_date) - new Date(a.income_date));

        res.json(combined);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch income data' });
    }
});

app.post('/api/owner/add-income', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { amount, source, description, category, payment_method } = req.body;
    if (!amount || amount <= 0 || !source) {
        return res.status(400).json({ error: 'Valid amount and source required' });
    }
    try {
        // Ensure other_income table exists
        await promiseDb.query(`
            CREATE TABLE IF NOT EXISTS other_income (
                income_id INT AUTO_INCREMENT PRIMARY KEY,
                source VARCHAR(255) NOT NULL,
                description TEXT,
                amount DECIMAL(10,2) NOT NULL,
                category VARCHAR(100) DEFAULT 'Other',
                payment_method VARCHAR(50) DEFAULT 'CASH',
                income_date DATE NOT NULL DEFAULT (CURDATE()),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await promiseDb.query(
            'INSERT INTO other_income (source, description, amount, category, payment_method, income_date) VALUES (?, ?, ?, ?, ?, CURDATE())',
            [source, description || '', amount, category || 'Other', payment_method || 'CASH']
        );
        res.json({ success: true, message: 'Income added successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add income' });
    }
});

app.get('/api/owner/complaints', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [complaints] = await promiseDb.query(`
            SELECT c.*, u.full_name as sender_name
            FROM complaints c
            JOIN users u ON c.sender_id = u.user_id
            ORDER BY c.created_at DESC
        `);
        res.json(complaints);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch complaints' });
    }
});

app.post('/api/owner/reply-complaint/:complaintId', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { complaintId } = req.params;
    const { reply } = req.body;

    if (!reply) {
        return res.status(400).json({ error: 'Reply message required' });
    }

    try {
        await promiseDb.query(
            'UPDATE complaints SET reply = ?, status = "REPLIED" WHERE complaint_id = ?',
            [reply, complaintId]
        );
        res.json({ success: true, message: 'Reply sent successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send reply' });
    }
});

// Chart data endpoint
app.get('/api/owner/chart-data', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        // Monthly revenue: combine customer payments + other income
        const [monthlyRevenue] = await promiseDb.query(`
            SELECT month, SUM(revenue) as revenue FROM (
                SELECT DATE_FORMAT(payment_date, '%Y-%m') as month, SUM(amount) as revenue
                FROM payments
                WHERE payment_date >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
                GROUP BY DATE_FORMAT(payment_date, '%Y-%m')
                UNION ALL
                SELECT DATE_FORMAT(income_date, '%Y-%m') as month, SUM(amount) as revenue
                FROM other_income
                WHERE income_date >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
                GROUP BY DATE_FORMAT(income_date, '%Y-%m')
            ) combined
            GROUP BY month
            ORDER BY month ASC
        `);

        const [revenueTotal] = await promiseDb.query('SELECT (SELECT COALESCE(SUM(amount),0) FROM payments) + (SELECT COALESCE(SUM(amount),0) FROM other_income WHERE 1) as total');
        const [expensesTotal] = await promiseDb.query('SELECT SUM(amount) as total FROM expenses');
        const [salariesTotal] = await promiseDb.query('SELECT SUM(amount) as total FROM expenses WHERE category = "Salary"');
        const [categoryExpenses] = await promiseDb.query('SELECT category, SUM(amount) as total FROM expenses GROUP BY category');

        res.json({
            monthlyRevenue: monthlyRevenue || [],
            revenueTotal: revenueTotal[0]?.total || 0,
            expensesTotal: expensesTotal[0]?.total || 0,
            salariesTotal: salariesTotal[0]?.total || 0,
            categoryExpenses: categoryExpenses || []
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch chart data' });
    }
});

// ============ EMPLOYEE ENDPOINTS ============

app.get('/api/employee/appointments/:employeeId', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { employeeId } = req.params;

    try {
        const [appointments] = await promiseDb.query(`
            SELECT a.*, c.full_name as customer_name, p.amount, p.payment_method,
                   COALESCE(s.service_name, a.custom_service) as service_description
            FROM appointments a
            JOIN customers c ON a.customer_id = c.customer_id
            LEFT JOIN services s ON a.service_id = s.service_id
            LEFT JOIN payments p ON a.appointment_id = p.appointment_id
            WHERE a.employee_id = (SELECT employee_id FROM employees WHERE user_id = ?)
            ORDER BY a.appointment_date DESC, a.appointment_time ASC
        `, [employeeId]);
        res.json(appointments);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch appointments' });
    }
});

app.put('/api/employee/appointments/:appointmentId/status', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { appointmentId } = req.params;
    const { status } = req.body;

    try {
        await promiseDb.query('UPDATE appointments SET status = ? WHERE appointment_id = ?', [status, appointmentId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update status' });
    }
});

app.put('/api/employee/appointments/:appointmentId/reschedule', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { appointmentId } = req.params;
    const { appointment_date, appointment_time } = req.body;

    try {
        await promiseDb.query(
            'UPDATE appointments SET appointment_date = ?, appointment_time = ? WHERE appointment_id = ?',
            [appointment_date, appointment_time, appointmentId]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reschedule' });
    }
});

app.get('/api/employee/salary/:employeeId', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { employeeId } = req.params;

    try {
        const [salary] = await promiseDb.query('SELECT salary FROM employees WHERE user_id = ?', [employeeId]);
        res.json({ salary: salary[0]?.salary || 0 });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch salary' });
    }
});

app.get('/api/employee/download-salary/:employeeId', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { employeeId } = req.params;

    try {
        const [salary] = await promiseDb.query('SELECT full_name, salary FROM employees WHERE user_id = ?', [employeeId]);
        if (salary.length === 0) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        const csv = `Full Name,Salary (M),Date\n${salary[0].full_name},${salary[0].salary},${new Date().toLocaleDateString()}`;
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=salary_${employeeId}.csv`);
        res.send(csv);
    } catch (error) {
        res.status(500).json({ error: 'Failed to download salary' });
    }
});

app.post('/api/employee/complaint', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { subject, message } = req.body;
    const userId = req.user.userId;

    try {
        await promiseDb.query(
            'INSERT INTO complaints (sender_id, sender_role, subject, message) VALUES (?, "EMPLOYEE", ?, ?)',
            [userId, subject, message]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send complaint' });
    }
});

app.get('/api/employee/my-complaints', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const userId = req.user.userId;

    try {
        const [complaints] = await promiseDb.query('SELECT * FROM complaints WHERE sender_id = ? ORDER BY created_at DESC', [userId]);
        res.json(complaints);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch complaints' });
    }
});

// ============ CUSTOMER ENDPOINTS ============

app.get('/api/customer/barbers', authenticateToken, authorizeRoles('CUSTOMER'), async (req, res) => {
    try {
        const [barbers] = await promiseDb.query(`
            SELECT e.employee_id, e.full_name, e.position
            FROM employees e
            JOIN users u ON e.user_id = u.user_id
            WHERE u.is_approved = 1
        `);
        res.json(barbers);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch barbers' });
    }
});

app.post('/api/customer/appointments', authenticateToken, authorizeRoles('CUSTOMER'), async (req, res) => {
    const { custom_service, appointment_date, appointment_time, payment_method, amount } = req.body;
    const userId = req.user.userId;

    try {
        const [customer] = await promiseDb.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]);
        if (customer.length === 0) {
            return res.status(404).json({ error: 'Customer profile not found' });
        }

        const [barber] = await promiseDb.query(`
            SELECT e.employee_id FROM employees e
            JOIN users u ON e.user_id = u.user_id
            WHERE u.is_approved = 1 LIMIT 1
        `);

        if (barber.length === 0) {
            return res.status(404).json({ error: 'No barbers available' });
        }

        const [appointment] = await promiseDb.query(
            'INSERT INTO appointments (customer_id, employee_id, custom_service, appointment_date, appointment_time, payment_status) VALUES (?, ?, ?, ?, ?, "UNPAID")',
            [customer[0].customer_id, barber[0].employee_id, custom_service, appointment_date, appointment_time]
        );

        await promiseDb.query('INSERT INTO payments (appointment_id, amount, payment_method) VALUES (?, ?, ?)',
            [appointment.insertId, amount, payment_method || 'CASH']);

        await promiseDb.query('UPDATE appointments SET payment_status = "PAID" WHERE appointment_id = ?', [appointment.insertId]);

        res.status(201).json({ success: true, message: 'Appointment booked successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to book appointment' });
    }
});

app.get('/api/customer/my-appointments/:userId', authenticateToken, authorizeRoles('CUSTOMER'), async (req, res) => {
    const { userId } = req.params;

    try {
        const [customer] = await promiseDb.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]);
        if (customer.length === 0) return res.json([]);

        const [appointments] = await promiseDb.query(`
            SELECT a.*, e.full_name as barber_name, p.amount, p.payment_method,
                   COALESCE(s.service_name, a.custom_service) as service_description
            FROM appointments a
            JOIN employees e ON a.employee_id = e.employee_id
            LEFT JOIN services s ON a.service_id = s.service_id
            LEFT JOIN payments p ON a.appointment_id = p.appointment_id
            WHERE a.customer_id = ?
            ORDER BY a.appointment_date DESC, a.appointment_time ASC
        `, [customer[0].customer_id]);
        res.json(appointments);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch appointments' });
    }
});

app.get('/api/customer/download-receipt/:appointmentId', authenticateToken, authorizeRoles('CUSTOMER'), async (req, res) => {
    const { appointmentId } = req.params;

    try {
        const [appointment] = await promiseDb.query(`
            SELECT a.*, e.full_name as barber_name, p.amount, p.payment_method
            FROM appointments a
            JOIN employees e ON a.employee_id = e.employee_id
            JOIN payments p ON a.appointment_id = p.appointment_id
            WHERE a.appointment_id = ?
        `, [appointmentId]);

        if (appointment.length === 0) {
            return res.status(404).json({ error: 'Appointment not found' });
        }

        const a = appointment[0];
        const csv = `LEVIS.BARBER RECEIPT\n\nAppointment ID,${a.appointment_id}\nService,${a.custom_service}\nBarber,${a.barber_name}\nDate,${a.appointment_date}\nTime,${a.appointment_time}\nAmount (M),${a.amount}\nPayment Method,${a.payment_method}\nStatus,${a.status}\nPayment Status,${a.payment_status}\n\nThank you for choosing LEVIS.BARBER!`;
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=receipt_${appointmentId}.csv`);
        res.send(csv);
    } catch (error) {
        res.status(500).json({ error: 'Failed to download receipt' });
    }
});

app.post('/api/customer/complaint', authenticateToken, authorizeRoles('CUSTOMER'), async (req, res) => {
    const { subject, message } = req.body;
    const userId = req.user.userId;

    try {
        await promiseDb.query('INSERT INTO complaints (sender_id, sender_role, subject, message) VALUES (?, "CUSTOMER", ?, ?)',
            [userId, subject, message]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send complaint' });
    }
});

app.get('/api/customer/my-complaints/:userId', authenticateToken, authorizeRoles('CUSTOMER'), async (req, res) => {
    const { userId } = req.params;

    try {
        const [complaints] = await promiseDb.query('SELECT * FROM complaints WHERE sender_id = ? ORDER BY created_at DESC', [userId]);
        res.json(complaints);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch complaints' });
    }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Backend running on http://localhost:${PORT}`);
    console.log(`📊 Database: levis_fis`);
});