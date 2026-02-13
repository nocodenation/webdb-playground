AUTHENTICATION_SOURCES = ["webserver"]
WEBSERVER_AUTO_CREATE_USER = True
WEBSERVER_REMOTE_USER = "X-Authentication-Email"
MASTER_PASSWORD = False
MASTER_PASSWORD_REQUIRED = False
ALLOW_SAVE_PASSWORD = True
SESSION_DB_PATH = "/var/lib/sessions"

ENHANCED_COOKIE_PROTECTION = False
WTF_CSRF_CHECK_DEFAULT = False
WTF_CSRF_ENABLED = False

DEFAULT_BINARY_PATHS = {
    'pg-17': '/usr/local/pgsql-17',
    'pg-16': '/usr/local/pgsql-16',
    'pg-15': '/usr/local/pgsql-15',
    'pg-14': '/usr/local/pgsql-14',
    'pg-13': '/usr/local/pgsql-13'
}

LOGOUT_REDIRECT_URL = "/auth/logout/"