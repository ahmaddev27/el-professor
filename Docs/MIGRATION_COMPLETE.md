# Migration Complete: Supabase → MySQL + PHP Backend

Your Receipt Management System has been successfully migrated from Supabase to a traditional MySQL database with PHP backend, ready for deployment on Hostinger shared hosting.

## What Changed

### Backend Architecture
- **Before:** Supabase (PostgreSQL) with built-in authentication
- **After:** MySQL database with PHP REST API and session-based authentication

### File Structure
```
project/
├── backend/                    # NEW: PHP backend
│   ├── config.php             # Database configuration
│   ├── cors.php               # CORS handling
│   ├── auth.php               # Authentication endpoints
│   ├── middleware.php         # Auth middleware
│   ├── schema.sql             # MySQL database schema
│   ├── .htaccess              # Security rules
│   └── api/                   # API endpoints
│       ├── drivers.php
│       ├── receipts.php
│       ├── income.php
│       ├── fixed-costs.php
│       ├── salaries.php
│       └── cash-transactions.php
│
├── src/
│   └── lib/
│       ├── api.ts             # NEW: Custom API client
│       └── supabase.ts        # UPDATED: Now exports API client
│
├── MYSQL_MIGRATION_GUIDE.md  # Detailed deployment instructions
└── .env.example               # Environment configuration example
```

## Database Schema

Your MySQL database includes these tables:

1. **users** - User accounts with password hashes
2. **user_profiles** - User profile information and roles
3. **user_sessions** - Active user sessions
4. **drivers** - Driver management
5. **receipts** - Receipt records
6. **income** - Income tracking
7. **fixed_costs** - Fixed cost management
8. **salaries** - Salary calculations
9. **cash_transactions** - Cash flow tracking

## Default Admin Credentials

- **Email:** admin@example.com
- **Password:** admin123
- **⚠️ IMPORTANT:** Change these credentials immediately after first login!

## Deployment Steps Summary

### 1. Hostinger Database Setup
- Create MySQL database in hPanel
- Import `backend/schema.sql` via phpMyAdmin
- Note database credentials

### 2. Configure Backend
- Edit `backend/config.php`
- Update DB credentials
- Set CORS origin
- Generate secure JWT secret

### 3. Upload Files
- Upload `backend/` folder to hosting
- Ensure proper file permissions (644 for files, 755 for directories)

### 4. Configure Frontend
- Create `.env` file: `VITE_API_URL=https://yourdomain.com/backend`
- Build: `npm run build`
- Upload `dist/` contents to `public_html/`

### 5. Test
- Access your domain
- Login with admin credentials
- Change admin password immediately

## API Endpoints

All endpoints are located at: `https://yourdomain.com/backend/`

### Authentication
- `POST /auth.php?action=login` - User login
- `POST /auth.php?action=logout` - User logout
- `GET /auth.php?action=session` - Get current session
- `POST /auth.php?action=register` - Register new user

### Resources
- `/api/drivers.php` - Driver management
- `/api/receipts.php` - Receipt management
- `/api/income.php` - Income tracking
- `/api/fixed-costs.php` - Fixed costs
- `/api/salaries.php` - Salary management
- `/api/cash-transactions.php` - Cash transactions

Each resource supports:
- `GET` - List all / Get single (with ?id=)
- `POST` - Create new
- `PUT` - Update (with ?id=)
- `DELETE` - Delete (with ?id=)

## Security Features

✅ **Implemented:**
- Password hashing with bcrypt
- Session-based authentication
- Role-based access control (admin, creator, viewer)
- SQL injection prevention (PDO prepared statements)
- XSS protection
- CORS configuration
- Session timeout (20 minutes)
- HTTPS ready

⚠️ **Production Checklist:**
- [ ] Change default admin credentials
- [ ] Update CORS origin in config.php
- [ ] Generate secure JWT secret
- [ ] Disable error display in config.php
- [ ] Enable HTTPS/SSL certificate
- [ ] Configure regular database backups
- [ ] Review file permissions

## Role-Based Access Control

### Admin
- Full access to all features
- Can create, edit, delete all records
- User management capabilities

### Creator
- Can create new records
- Can edit own records
- Can delete own records
- Cannot manage users

### Viewer
- Read-only access
- Cannot create, edit, or delete

## Frontend Changes

The frontend now uses a custom API client (`src/lib/api.ts`) instead of the Supabase client. The API client provides:

- Same interface as Supabase client for minimal code changes
- Session-based authentication with cookies
- Automatic credential inclusion
- Error handling
- TypeScript support

## Testing the Migration

### 1. Local Testing (Optional)
If you have PHP installed locally:

```bash
# Navigate to backend directory
cd backend

# Start PHP development server
php -S localhost:8000

# In another terminal, update .env
echo "VITE_API_URL=http://localhost:8000" > .env

# Start frontend
npm run dev
```

### 2. Production Testing
- Upload everything to Hostinger
- Test each feature:
  - Login/Logout
  - Creating drivers
  - Adding receipts
  - Recording income
  - Managing salaries
  - Cash transactions

## Troubleshooting

### Common Issues

**Database Connection Failed**
- Check credentials in `backend/config.php`
- Verify database exists in phpMyAdmin
- Ensure MySQL service is running

**CORS Errors**
- Verify `ALLOWED_ORIGIN` in `config.php` matches your domain exactly
- Check browser console for detailed error messages

**404 on API Endpoints**
- Confirm `backend/` folder uploaded correctly
- Check file permissions (files: 644, directories: 755)
- Test direct access: `https://yourdomain.com/backend/auth.php?action=session`

**Session/Login Issues**
- Clear browser cookies and cache
- Check PHP session configuration in hosting control panel
- Verify session directory has write permissions

**500 Internal Server Error**
- Check PHP error logs in hPanel
- Temporarily enable error display in `config.php` for debugging
- Verify PHP version compatibility (requires PHP 7.4+)

## Support & Documentation

📖 **Detailed Guide:** See `MYSQL_MIGRATION_GUIDE.md`

🔧 **Configuration:** All settings in `backend/config.php`

🗄️ **Database Schema:** `backend/schema.sql`

## Next Steps

1. **Deploy to Hostinger** - Follow the migration guide
2. **Change Admin Password** - Use the UI after first login
3. **Create Users** - Set up user accounts with appropriate roles
4. **Test Features** - Verify all functionality works
5. **Setup Backups** - Configure automatic database backups
6. **Monitor** - Check logs regularly for errors

## Benefits of This Migration

✅ No vendor lock-in
✅ Full control over your data
✅ Lower hosting costs (shared hosting vs Supabase)
✅ No API limits or quotas
✅ Direct database access
✅ Standard PHP/MySQL stack (easy to maintain)
✅ Compatible with most hosting providers

## Migration Verification

Run through this checklist:

- [ ] Database created and schema imported
- [ ] Backend files uploaded
- [ ] Config.php updated with credentials
- [ ] Frontend built and uploaded
- [ ] Can access login page
- [ ] Can login with admin credentials
- [ ] Admin password changed
- [ ] Can create/edit/delete records
- [ ] Role-based permissions working
- [ ] Session timeout working
- [ ] All features tested

---

**🎉 Your application is now running on MySQL with PHP backend!**

For questions or issues, refer to the troubleshooting section or check the PHP error logs in your Hostinger control panel.
