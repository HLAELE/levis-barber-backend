const express = require('express');
const mysql = require('mysql2');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// CORS Configuration
const allowedOrigins = [
    'https://levis-barber-frontend-nufm.vercel.app',
    'https://levis-barber-frontend.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001'
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    } else if (origin && origin.includes('vercel.app')) {
        res.header('Access-Control-Allow-Origin', origin);
    } else {
        res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

app.use(express.json());

// Database Connection
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'levis_fis';
const DB_PORT = parseInt(process.env.DB_PORT || '3306');
const DB_SSL = DB_HOST.includes('aivencloud');

const db = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    port: DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: DB_SSL ? { rejectUnauthorized: false } : false
});

const promiseDb = db.promise();
const JWT_SECRET = process.env.JWT_SECRET || 'levis_barber_secret_key_2026';

console.log('✅ Server starting...');

// ============ MIDDLEWARE ============
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

const authorizeRoles = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
        next();
    };
};

// ============ AUTH ENDPOINTS ============
app.post('/api/auth/register', async (req, res) => {
    const { full_name, username, password, role, phone, email } = req.body;
    if (!full_name || !username || !password) {
        return res.status(400).json({ error: 'All fields required' });
    }
    try {
        const [existing] = await promiseDb.query('SELECT user_id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const isApproved = role === 'EMPLOYEE' ? 0 : 1;
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
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign(
            { userId: user.user_id, username: user.username, role: user.role, full_name: user.full_name },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({ success: true, token, user: { userId: user.user_id, full_name: user.full_name, username: user.username, role: user.role } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/test/users', async (req, res) => {
    try {
        const [users] = await promiseDb.query('SELECT user_id, full_name, username, role, is_approved FROM users');
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ OWNER DASHBOARD ============
app.get('/api/owner/dashboard', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [paymentsResult] = await promiseDb.query('SELECT COALESCE(SUM(amount), 0) as total FROM payments');
        const [expensesResult] = await promiseDb.query('SELECT COALESCE(SUM(amount), 0) as total FROM expenses');
        const [customersResult] = await promiseDb.query('SELECT COUNT(*) as count FROM customers');
        const totalRevenue = parseFloat(paymentsResult[0].total) || 0;
        const totalExpenses = parseFloat(expensesResult[0].total) || 0;
        res.json({
            totalRevenue,
            totalExpenses,
            netProfit: totalRevenue - totalExpenses,
            totalCustomers: customersResult[0].count || 0
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
});

// ============ CHART DATA ============
app.get('/api/owner/chart-data', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        let [monthlyRevenue] = await promiseDb.query(`
            SELECT DATE_FORMAT(payment_date, '%b') as month, MONTH(payment_date) as month_num, COALESCE(SUM(amount), 0) as revenue
            FROM payments
            WHERE payment_date >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
            GROUP BY month, month_num
            ORDER BY month_num ASC
        `);
        if (!monthlyRevenue || monthlyRevenue.length === 0) {
            monthlyRevenue = [
                { month: 'Jan', revenue: 0 }, { month: 'Feb', revenue: 0 },
                { month: 'Mar', revenue: 0 }, { month: 'Apr', revenue: 0 },
                { month: 'May', revenue: 0 }, { month: 'Jun', revenue: 0 },
                { month: 'Jul', revenue: 0 }, { month: 'Aug', revenue: 0 },
                { month: 'Sep', revenue: 0 }, { month: 'Oct', revenue: 0 },
                { month: 'Nov', revenue: 0 }, { month: 'Dec', revenue: 0 }
            ];
        }
        const [paymentsTotal] = await promiseDb.query('SELECT COALESCE(SUM(amount), 0) as total FROM payments');
        const [expensesTotal] = await promiseDb.query('SELECT COALESCE(SUM(amount), 0) as total FROM expenses');
        const [salariesTotal] = await promiseDb.query("SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE category = 'Salary'");
        const [categoryExpenses] = await promiseDb.query('SELECT category, COALESCE(SUM(amount), 0) as total FROM expenses GROUP BY category');
        
        const revenueTotal = parseFloat(paymentsTotal[0]?.total) || 0;
        const totalExp = parseFloat(expensesTotal[0]?.total) || 0;
        const salariesTotalVal = parseFloat(salariesTotal[0]?.total) || 0;
        const nonSalaryExpenses = Math.max(0, totalExp - salariesTotalVal);

        res.json({
            monthlyRevenue,
            revenueTotal,
            expensesTotal: totalExp,
            nonSalaryExpenses,
            salariesTotal: salariesTotalVal,
            categoryExpenses: categoryExpenses || []
        });
    } catch (error) {
        console.error('Chart data error:', error);
        res.status(500).json({ error: 'Failed to fetch chart data' });
    }
});

// ============ PENDING EMPLOYEES ============
app.get('/api/owner/pending-employees', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [employees] = await promiseDb.query(`
            SELECT user_id, full_name, username, created_at 
            FROM users WHERE role = 'EMPLOYEE' AND is_approved = 0
        `);
        res.json(employees);
    } catch (error) { res.json([]); }
});

// ============ APPROVE EMPLOYEE ============
app.post('/api/owner/approve-employee/:userId', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { userId } = req.params;
    const { position, salary, phone, hire_date } = req.body;
    try {
        const [users] = await promiseDb.query("SELECT full_name FROM users WHERE user_id = ? AND role = 'EMPLOYEE'", [userId]);
        if (users.length === 0) return res.status(404).json({ error: 'Employee not found' });
        await promiseDb.query('UPDATE users SET is_approved = 1 WHERE user_id = ?', [userId]);
        await promiseDb.query(
            'INSERT INTO employees (full_name, phone, position, salary, hire_date, user_id) VALUES (?, ?, ?, ?, ?, ?)',
            [users[0].full_name, phone || null, position || 'Barber', salary || 0, hire_date || new Date(), userId]
        );
        res.json({ success: true, message: 'Employee approved successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to approve employee' });
    }
});

// ============ REJECT EMPLOYEE ============
app.delete('/api/owner/reject-employee/:userId', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { userId } = req.params;
    try {
        await promiseDb.query("DELETE FROM users WHERE user_id = ? AND role = 'EMPLOYEE' AND is_approved = 0", [userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reject employee' });
    }
});

// ============ GET EMPLOYEES ============
app.get('/api/owner/employees', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [employees] = await promiseDb.query('SELECT employee_id, full_name, position, salary FROM employees');
        res.json(employees);
    } catch (error) { res.json([]); }
});

// ============ PAY SALARY ============
app.post('/api/owner/pay-salary', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { employee_id, amount } = req.body;
    try {
        const [emp] = await promiseDb.query('SELECT full_name FROM employees WHERE employee_id = ?', [employee_id]);
        await promiseDb.query('UPDATE employees SET salary = ? WHERE employee_id = ?', [amount, employee_id]);
        await promiseDb.query(
            "INSERT INTO expenses (description, amount, category, expense_date) VALUES (?, ?, 'Salary', CURDATE())",
            [`Salary payment to ${emp[0].full_name}`, amount]
        );
        const currentMonth = new Date().getMonth() + 1;
        const currentYear = new Date().getFullYear();
        await promiseDb.query(`
            INSERT INTO salaries (employee_id, month, year, amount, paid_date)
            VALUES (?, ?, ?, ?, CURDATE())
            ON DUPLICATE KEY UPDATE amount = VALUES(amount), paid_date = VALUES(paid_date)
        `, [employee_id, currentMonth, currentYear, amount]);
        res.json({ success: true });
    } catch (error) {
        console.error('Pay salary error:', error);
        res.status(500).json({ error: 'Failed to pay salary' });
    }
});

// ============ INCOME MANAGEMENT ============
app.get('/api/owner/income', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [income] = await promiseDb.query(`
            SELECT 
                p.payment_id as id,
                c.full_name as customer_name,
                p.appointment_id,
                p.amount,
                p.payment_method,
                p.payment_date as date
            FROM payments p
            JOIN appointments a ON p.appointment_id = a.appointment_id
            JOIN customers c ON a.customer_id = c.customer_id
            ORDER BY p.payment_date DESC, p.payment_id DESC
        `);
        res.json(income);
    } catch (error) { 
        console.error('Fetch income error:', error);
        res.json([]); 
    }
});

app.post('/api/owner/add-income', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { source, amount, description, category, payment_method, income_date } = req.body;
    if (!source || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Source and valid amount required' });
    }
    try {
        const date = income_date || new Date().toISOString().split('T')[0];
        await promiseDb.query(
            'INSERT INTO income (source, amount, description, category, payment_method, income_date) VALUES (?, ?, ?, ?, ?, ?)',
            [source, amount, description || null, category || 'Other', payment_method || 'CASH', date]
        );
        res.json({ success: true, message: 'Income added successfully' });
    } catch (error) {
        console.error('Add income error:', error);
        res.status(500).json({ error: 'Failed to add income' });
    }
});

app.delete('/api/owner/delete-income/:id', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { id } = req.params;
    try {
        await promiseDb.query('DELETE FROM income WHERE income_id = ?', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete income' });
    }
});

// ============ EXPENSE MANAGEMENT ============
app.get('/api/owner/expenses', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [expenses] = await promiseDb.query(`
            SELECT expense_id as id, description, amount, category, expense_date as date 
            FROM expenses ORDER BY expense_date DESC
        `);
        res.json(expenses);
    } catch (error) { res.json([]); }
});

app.post('/api/owner/add-expense', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { description, amount, category, expense_date } = req.body;
    if (!description || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Description and valid amount required' });
    }
    try {
        const date = expense_date || new Date().toISOString().split('T')[0];
        await promiseDb.query(
            'INSERT INTO expenses (description, amount, category, expense_date) VALUES (?, ?, ?, ?)',
            [description, amount, category || 'Other', date]
        );
        res.json({ success: true, message: 'Expense added successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add expense' });
    }
});

app.delete('/api/owner/delete-expense/:id', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { id } = req.params;
    try {
        await promiseDb.query('DELETE FROM expenses WHERE expense_id = ?', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete expense' });
    }
});

// ============ COMPLAINTS ============
app.get('/api/owner/complaints', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    try {
        const [complaints] = await promiseDb.query(`
            SELECT c.*, u.full_name as sender_name 
            FROM complaints c 
            JOIN users u ON c.user_id = u.user_id 
            ORDER BY c.created_at DESC
        `);
        res.json(complaints);
    } catch (error) { res.json([]); }
});

app.post('/api/owner/reply-complaint/:id', authenticateToken, authorizeRoles('OWNER'), async (req, res) => {
    const { id } = req.params;
    const { reply } = req.body;
    try {
        await promiseDb.query("UPDATE complaints SET reply = ?, status = 'RESOLVED' WHERE complaint_id = ?", [reply, id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reply' });
    }
});

// ============ EMPLOYEE ENDPOINTS ============
app.get('/api/employee/appointments/:employeeId', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { employeeId } = req.params; // this is user_id from the frontend
    try {
        const [emp] = await promiseDb.query('SELECT employee_id FROM employees WHERE user_id = ?', [employeeId]);
        if (emp.length === 0) return res.json([]);
        const dbEmployeeId = emp[0].employee_id;
        const [appointments] = await promiseDb.query(`
            SELECT a.*, c.full_name as customer_name, p.amount, p.payment_method,
                   a.notes as service_description,
                   a.time_slot as appointment_time,
                   CASE WHEN p.amount IS NOT NULL THEN 'PAID' ELSE 'UNPAID' END as payment_status
            FROM appointments a
            JOIN customers c ON a.customer_id = c.customer_id
            LEFT JOIN payments p ON a.appointment_id = p.appointment_id
            WHERE a.employee_id = ?
            ORDER BY a.appointment_date DESC, a.time_slot ASC
        `, [dbEmployeeId]);
        res.json(appointments);
    } catch (error) { 
        console.error('Employee appointments error:', error);
        res.json([]); 
    }
});

app.put('/api/employee/appointments/:appointmentId/status', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { appointmentId } = req.params;
    const { status } = req.body;
    try {
        await promiseDb.query('UPDATE appointments SET status = ? WHERE appointment_id = ?', [status, appointmentId]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Failed to update status' }); }
});

app.put('/api/employee/appointments/:appointmentId/reschedule', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { appointmentId } = req.params;
    const { appointment_date, appointment_time } = req.body;
    try {
        await promiseDb.query('UPDATE appointments SET appointment_date = ?, time_slot = ? WHERE appointment_id = ?', [appointment_date, appointment_time, appointmentId]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Failed to reschedule' }); }
});

app.get('/api/employee/salary/:employeeId', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { employeeId } = req.params; // user_id
    try {
        const [salary] = await promiseDb.query('SELECT salary FROM employees WHERE user_id = ?', [employeeId]);
        res.json({ salary: salary[0]?.salary || 0 });
    } catch (error) { res.json({ salary: 0 }); }
});

app.get('/api/employee/download-salary/:employeeId', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { employeeId } = req.params; // user_id
    try {
        const [emp] = await promiseDb.query('SELECT full_name, salary FROM employees WHERE user_id = ?', [employeeId]);
        const csv = `LEVIS.BARBER SALARY SLIP\n\nEmployee: ${emp[0].full_name}\nSalary Amount: M ${emp[0].salary}\nDate: ${new Date().toLocaleDateString()}\n\nThis is an official salary slip.`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=salary_${employeeId}.csv`);
        res.send(csv);
    } catch (error) { 
        console.error('Download salary error:', error);
        res.status(500).json({ error: 'Failed to download salary' }); 
    }
});

app.post('/api/employee/complaint', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const { subject, message } = req.body;
    const userId = req.user.userId;
    try {
        await promiseDb.query("INSERT INTO complaints (user_id, role, subject, message) VALUES (?, 'EMPLOYEE', ?, ?)", [userId, subject, message]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Failed to send complaint' }); }
});

app.get('/api/employee/my-complaints', authenticateToken, authorizeRoles('EMPLOYEE'), async (req, res) => {
    const userId = req.user.userId;
    try {
        const [complaints] = await promiseDb.query('SELECT * FROM complaints WHERE user_id = ? ORDER BY created_at DESC', [userId]);
        res.json(complaints);
    } catch (error) { res.json([]); }
});

// ============ CUSTOMER ENDPOINTS ============
app.post('/api/customer/appointments', authenticateToken, authorizeRoles('CUSTOMER'), async (req, res) => {
    const { custom_service, appointment_date, appointment_time, payment_method, amount } = req.body;
    const userId = req.user.userId;
    try {
        const [customer] = await promiseDb.query('SELECT customer_id FROM customers WHERE user_id = ?', [userId]);
        if (customer.length === 0) return res.status(404).json({ error: 'Customer profile not found' });
        const [barber] = await promiseDb.query(`
            SELECT e.employee_id FROM employees e JOIN users u ON e.user_id = u.user_id WHERE u.is_approved = 1 LIMIT 1
        `);
        if (barber.length === 0) return res.status(404).json({ error: 'No barbers available' });
        const [appointment] = await promiseDb.query(
            "INSERT INTO appointments (customer_id, employee_id, notes, appointment_date, time_slot, status) VALUES (?, ?, ?, ?, ?, 'PENDING')",
            [customer[0].customer_id, barber[0].employee_id, custom_service, appointment_date, appointment_time]
        );
        await promiseDb.query('INSERT INTO payments (appointment_id, amount, payment_method, payment_date) VALUES (?, ?, ?, ?)', [appointment.insertId, amount, payment_method || 'CASH', appointment_date]);
        res.status(201).json({ success: true, message: 'Appointment booked successfully', appointmentId: appointment.insertId });
    } catch (error) { 
        console.error('Book appointment error:', error);
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
                   a.notes as service_description,
                   a.time_slot as appointment_time,
                   CASE WHEN p.amount IS NOT NULL THEN 'PAID' ELSE 'UNPAID' END as payment_status
            FROM appointments a
            JOIN employees e ON a.employee_id = e.employee_id
            LEFT JOIN payments p ON a.appointment_id = p.appointment_id
            WHERE a.customer_id = ?
            ORDER BY a.appointment_date DESC, a.time_slot ASC
        `, [customer[0].customer_id]);
        res.json(appointments);
    } catch (error) { 
        console.error('Fetch customer appointments error:', error);
        res.json([]); 
    }
});

app.get('/api/customer/download-receipt/:appointmentId', authenticateToken, authorizeRoles('CUSTOMER'), async (req, res) => {
    const { appointmentId } = req.params;
    try {
        const [appt] = await promiseDb.query(`
            SELECT a.*, e.full_name as barber_name, p.amount, p.payment_method
            FROM appointments a
            JOIN employees e ON a.employee_id = e.employee_id
            JOIN payments p ON a.appointment_id = p.appointment_id
            WHERE a.appointment_id = ?
        `, [appointmentId]);
        if (appt.length === 0) return res.status(404).json({ error: 'Appointment not found' });
        const a = appt[0];
        const csv = `LEVIS.BARBER BOOKING RECEIPT\n\nAppointment ID: ${a.appointment_id}\nService: ${a.notes || 'N/A'}\nBarber: ${a.barber_name}\nDate: ${a.appointment_date}\nTime: ${a.time_slot}\nAmount Paid: M ${a.amount}\nPayment Method: ${a.payment_method}\nStatus: ${a.status}\n\nThank you for choosing LEVIS.BARBER!`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=receipt_${appointmentId}.csv`);
        res.send(csv);
    } catch (error) { res.status(500).json({ error: 'Failed to download receipt' }); }
});

app.post('/api/customer/complaint', authenticateToken, authorizeRoles('CUSTOMER'), async (req, res) => {
    const { subject, message } = req.body;
    const userId = req.user.userId;
    try {
        await promiseDb.query("INSERT INTO complaints (user_id, role, subject, message) VALUES (?, 'CUSTOMER', ?, ?)", [userId, subject, message]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Failed to send complaint' }); }
});

app.get('/api/customer/my-complaints/:userId', authenticateToken, authorizeRoles('CUSTOMER'), async (req, res) => {
    const { userId } = req.params;
    try {
        const [complaints] = await promiseDb.query('SELECT * FROM complaints WHERE user_id = ? ORDER BY created_at DESC', [userId]);
        res.json(complaints);
    } catch (error) { res.json([]); }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Backend running on port ${PORT}`);
    console.log(`📊 Database: ${DB_NAME}`);
    console.log(`🔐 JWT Secret: ${JWT_SECRET ? 'Set' : 'Using default'}`);
});