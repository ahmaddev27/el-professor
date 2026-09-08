# MySQL Migration Guide - Hostinger Deployment

This guide will help you migrate your Receipt Management System from Supabase to MySQL on Hostinger shared hosting.

## Prerequisites

- Active Hostinger shared hosting account
- MySQL database created in Hostinger control panel
- FTP/SFTP access to your hosting
- Domain or subdomain configured

## Step 1: Create MySQL Database

1. Log in to your Hostinger control panel (hPanel)
2. Navigate to **Databases** → **MySQL Databases**
3. Click **Create New Database**
4. Note down:
   - Database name
   - Database username
   - Database password
   - Database host (usually `localhost`)

## Step 2: Import Database Schema

1. In hPanel, go to **Databases** → **phpMyAdmin**
2. Select your newly created database
3. Click on the **SQL** tab
4. Copy the contents of `backend/schema.sql`
5. Paste into the SQL query box
6. Click **Go** to execute

This will create all tables and insert a default admin user:
- Email: `admin@example.com`
- Password: `admin123`
- **IMPORTANT:** Change this password immediately after first login!

## Step 3: Configure Backend

1. Open `backend/config.php`
2. Update the database credentials:

```php
define('DB_HOST', 'localhost'); // Your MySQL host
define('DB_NAME', 'your_database_name'); // Your database name from Step 1
define('DB_USER', 'your_database_user'); // Your database username
define('DB_PASS', 'your_database_password'); // Your database password
```

3. Update the CORS configuration with your frontend URL:

```php
define('ALLOWED_ORIGIN', 'https://yourdomain.com'); // Your actual domain
```

4. Change the JWT secret to a secure random string:

```php
define('JWT_SECRET', 'generate-a-secure-random-string-here');
```

You can generate a secure string using: https://generate-secret.vercel.app/32

## Step 4: Upload Backend Files

Using FTP/SFTP, upload the `backend` folder to your hosting:

```
public_html/
├── backend/
│   ├── config.php
│   ├── cors.php
│   ├── auth.php
│   ├── middleware.php
│   ├── schema.sql
│   └── api/
│       ├── drivers.php
│       ├── receipts.php
│       ├── income.php
│       ├── fixed-costs.php
│       ├── salaries.php
│       └── cash-transactions.php
```

**Note:** Ensure the `backend` folder is accessible via URL (e.g., `https://yourdomain.com/backend/`)

## Step 5: Configure Frontend

1. Create/update `.env` file with your API URL:

```env
VITE_API_URL=https://yourdomain.com/backend
```

2. The frontend code has been updated to use the new PHP backend instead of Supabase

## Step 6: Build and Deploy Frontend

1. Install dependencies (if not already done):
```bash
npm install
```

2. Build the frontend:
```bash
npm run build
```

3. Upload the contents of the `dist` folder to your `public_html` directory (or subdirectory)

## Step 7: Configure .htaccess for React Router

Create a `.htaccess` file in your `public_html` directory:

```apache
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>
```

This ensures that React Router works correctly with direct URL access.

## Step 8: Test Your Application

1. Navigate to your domain: `https://yourdomain.com`
2. You should see the login page
3. Log in with the default admin credentials:
   - Email: `admin@example.com`
   - Password: `admin123`
4. **Immediately change the admin password** after logging in

## Step 9: Security Hardening

### 1. Disable error display in production

In `backend/config.php`, change:
```php
error_reporting(0);
ini_set('display_errors', 0);
```

### 2. Protect backend directory

Add this to `backend/.htaccess`:
```apache
# Deny access to config and schema files
<FilesMatch "(config|schema)\.php$">
    Order Allow,Deny
    Deny from all
</FilesMatch>
```

### 3. Enable HTTPS

Hostinger provides free SSL certificates. Enable it in your control panel.

### 4. Change default admin credentials

Use the application UI to change the admin email and password.

## Troubleshooting

### Database Connection Issues

- Verify database credentials in `config.php`
- Check if MySQL service is running
- Ensure your hosting plan supports remote MySQL connections

### CORS Errors

- Verify `ALLOWED_ORIGIN` in `config.php` matches your frontend URL exactly
- Check browser console for specific CORS error messages
- Ensure your hosting allows `.htaccess` modifications

### 404 Errors on API Endpoints

- Check that `backend` folder is uploaded correctly
- Verify file permissions (typically 644 for files, 755 for directories)
- Test direct access: `https://yourdomain.com/backend/auth.php?action=session`

### Session Issues

- Check PHP session configuration in hosting control panel
- Verify session directory has write permissions
- Clear browser cookies and try again

## File Structure

```
Your Hostinger Hosting:
├── public_html/
│   ├── backend/          (PHP API files)
│   ├── assets/           (Built frontend assets)
│   ├── index.html        (Frontend entry point)
│   └── .htaccess         (Rewrite rules)
```

## Database Backup

Regularly backup your database:

1. Go to phpMyAdmin
2. Select your database
3. Click **Export**
4. Choose **Quick** export method
5. Click **Go** to download

Store backups securely offline.

## Need Help?

Common issues and solutions:

1. **500 Internal Server Error**: Check PHP error logs in hPanel
2. **Database connection failed**: Verify credentials and database exists
3. **Login not working**: Clear browser cache and cookies
4. **API returns 404**: Check file paths and .htaccess configuration

## Next Steps

- Change default admin credentials
- Create additional user accounts with appropriate roles
- Configure regular database backups
- Monitor application logs for errors
- Consider implementing rate limiting for API endpoints

---

**Your application is now running on MySQL with PHP backend!**
