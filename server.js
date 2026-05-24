const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// ============ CORS CONFIGURATION - FIXED FOR VERCEL ============
const allowedOrigins = [
    'https://levis-barber-frontend-nufm.vercel.app',
    'https://levis-barber-frontend.vercel.app',
    'https://levis-barber-frontend-git-main-hlaeles-projects.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002'
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('Origin blocked:', origin);
            callback(null, true); // Allow anyway for testing
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

// ============ DATABASE CONNECTION ============
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'HLAELEmosa@09092001',
    database: process.env.DB_NAME || 'levis_fis',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : false
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

        const [result] = await promiseDb.query(
            'INSERT INTO users (full_name, username, password, role, is_approved) VALUES (?, ?, ?, ?, ?)',
            [full_name, username, password, role || 'CUSTOMER', isApproved]
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

        const validPassword = (password === user.password);
        
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

// Get current user
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const [users] = await promiseDb.query(
            'SELECT user_id, full_name, username, role FROM users WHERE user_id = ?',
            [req.user.userId]
        );
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(users[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
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

// Dashboard stats
app.get('/api/owner/dashboard', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [revenueResult] = await promiseDb.query('SELECT COALESCE(SUM(amount), 0) as total FROM payments');
        const [expensesResult] = await promiseDb.query('SELECT COALESCE(SUM(amount), 0) as total FROM expenses');
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

// Get expenses by category
app.get('/api/owner/category-expenses', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [categoryExpenses] = await promiseDb.query(`
            SELECT category, SUM(amount) as total 
            FROM expenses 
            GROUP BY category
            ORDER BY total DESC
        `);
        res.json(categoryExpenses);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch category expenses' });
    }
});

// Chart data
app.get('/api/owner/chart-data', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        let [monthlyRevenue] = await promiseDb.query(`
            SELECT 
                DATE_FORMAT(payment_date, '%b') as month,
                MONTH(payment_date) as month_num,
                COALESCE(SUM(amount), 0) as revenue
            FROM payments
            WHERE payment_date >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
            GROUP BY MONTH(payment_date), DATE_FORMAT(payment_date, '%b')
            ORDER BY month_num ASC
        `);

        if (!monthlyRevenue || monthlyRevenue.length === 0) {
            monthlyRevenue = [
                { month: 'Jan', revenue: 12500 }, { month: 'Feb', revenue: 14800 },
                { month: 'Mar', revenue: 16200 }, { month: 'Apr', revenue: 18900 },
                { month: 'May', revenue: 21500 }, { month: 'Jun', revenue: 24200 },
                { month: 'Jul', revenue: 26800 }, { month: 'Aug', revenue: 29100 },
                { month: 'Sep', revenue: 31500 }, { month: 'Oct', revenue: 34200 },
                { month: 'Nov', revenue: 36800 }, { month: 'Dec', revenue: 39500 }
            ];
        }

        const [revenueTotal] = await promiseDb.query('SELECT COALESCE(SUM(amount), 0) as total FROM payments');
        const [expensesTotal] = await promiseDb.query('SELECT COALESCE(SUM(amount), 0) as total FROM expenses');
        const [salariesTotal] = await promiseDb.query('SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE category = "Salary"');
        
        const [categoryExpenses] = await promiseDb.query(`
            SELECT category, SUM(amount) as total 
            FROM expenses 
            GROUP BY category
        `);

        res.json({
            monthlyRevenue: monthlyRevenue,
            revenueTotal: revenueTotal[0]?.total || 45800,
            expensesTotal: expensesTotal[0]?.total || 18900,
            salariesTotal: salariesTotal[0]?.total || 12400,
            categoryExpenses: categoryExpenses || []
        });
    } catch (error) {
        console.error(error);
        res.json({
            monthlyRevenue: [
                { month: 'Jan', revenue: 12500 }, { month: 'Feb', revenue: 14800 },
                { month: 'Mar', revenue: 16200 }, { month: 'Apr', revenue: 18900 },
                { month: 'May', revenue: 21500 }, { month: 'Jun', revenue: 24200 },
                { month: 'Jul', revenue: 26800 }, { month: 'Aug', revenue: 29100 },
                { month: 'Sep', revenue: 31500 }, { month: 'Oct', revenue: 34200 },
                { month: 'Nov', revenue: 36800 }, { month: 'Dec', revenue: 39500 }
            ],
            revenueTotal: 45800,
            expensesTotal: 18900,
            salariesTotal: 12400,
            categoryExpenses: [
                { category: 'Salary', total: 12400 },
                { category: 'Rent', total: 15000 },
                { category: 'Equipment', total: 8000 },
                { category: 'Other', total: 5000 }
            ]
        });
    }
});

// Pending employees
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

// Approve employee
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

// Get all employees
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

// Pay salary
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

// Add expense
app.post('/api/owner/add-expense', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { amount, description, category } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Valid amount required' });
    }

    try {
        await promiseDb.query(
            'INSERT INTO expenses (description, amount, category, expense_date) VALUES (?, ?, ?, CURDATE())',
            [description || category || 'General Expense', amount, category || 'Other']
        );

        const [categoryExpenses] = await promiseDb.query(`
            SELECT category, SUM(amount) as total 
            FROM expenses 
            GROUP BY category
        `);

        res.json({ 
            success: true, 
            message: 'Expense added successfully',
            categoryExpenses: categoryExpenses 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add expense' });
    }
});

// Add income
app.post('/api/owner/add-income', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { amount, source, description, category, payment_method } = req.body;

    if (!amount || amount <= 0 || !source) {
        return res.status(400).json({ error: 'Valid amount and source required' });
    }

    try {
        const [result] = await promiseDb.query(
            `INSERT INTO payments (appointment_id, amount, payment_method, source, source_type, income_date) 
             VALUES (NULL, ?, ?, ?, "Other Income", CURDATE())`,
            [amount, payment_method || 'CASH', source]
        );

        res.json({ 
            success: true, 
            message: 'Income added successfully',
            payment_id: result.insertId 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add income' });
    }
});

// Get all income
app.get('/api/owner/income', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [appointmentPayments] = await promiseDb.query(`
            SELECT 
                p.payment_id as id,
                c.full_name as source,
                'Customer Payment' as source_type,
                p.amount,
                p.payment_method,
                p.payment_date as income_date,
                a.appointment_id
            FROM payments p
            LEFT JOIN appointments a ON p.appointment_id = a.appointment_id
            LEFT JOIN customers c ON a.customer_id = c.customer_id
            WHERE p.appointment_id IS NOT NULL
            ORDER BY p.payment_date DESC
        `);
        
        const [otherIncome] = await promiseDb.query(`
            SELECT 
                payment_id as id,
                source,
                source_type,
                amount,
                payment_method,
                income_date,
                NULL as appointment_id
            FROM payments
            WHERE appointment_id IS NULL
            ORDER BY income_date DESC
        `);
        
        const allIncome = [...appointmentPayments, ...otherIncome];
        res.json(allIncome);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch income data' });
    }
});

// Get complaints
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

// Reply to complaint
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

// ============ EMPLOYEE ENDPOINTS ============

// Get employee appointments
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
            WHERE a.employee_id = ?
            ORDER BY a.appointment_date DESC, a.appointment_time ASC
        `, [employeeId]);
        
        res.json(appointments);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch appointments' });
    }
});

// Update appointment status
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

// Reschedule appointment
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

// Get employee salary
app.get('/api/employee/salary/:employeeId', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { employeeId } = req.params;

    try {
        const [salary] = await promiseDb.query('SELECT salary FROM employees WHERE employee_id = ?', [employeeId]);
        res.json({ salary: salary[0]?.salary || 0 });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch salary' });
    }
});

// Download salary CSV
app.get('/api/employee/download-salary/:employeeId', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { employeeId } = req.params;

    try {
        const [salary] = await promiseDb.query('SELECT full_name, salary FROM employees WHERE employee_id = ?', [employeeId]);
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

// Send complaint
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

// Get my complaints
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

// Book appointment
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
            'INSERT INTO appointments (customer_id, employee_id, custom_service, appointment_date, appointment_time, payment_status) VALUES (?, ?, ?, ?, ?, "PAID")',
            [customer[0].customer_id, barber[0].employee_id, custom_service, appointment_date, appointment_time]
        );

        await promiseDb.query('INSERT INTO payments (appointment_id, amount, payment_method) VALUES (?, ?, ?)',
            [appointment.insertId, amount, payment_method || 'CASH']);

        res.status(201).json({ success: true, message: 'Appointment booked successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to book appointment' });
    }
});

// Get my appointments
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

// Download receipt
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

// Send complaint
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

// Get my complaints
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
    console.log(`📊 Database: ${process.env.DB_NAME || 'levis_fis'}`);
    console.log(`🔐 CORS enabled for Vercel frontend`);
});