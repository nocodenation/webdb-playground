##########################################################################
#
# pgAdmin 4 - PostgreSQL Tools
#
# Copyright (C) 2013 - 2025, The pgAdmin Development Team
# This software is released under the PostgreSQL Licence
#
##########################################################################

"""A blueprint module implementing the Webserver authentication."""
import os
import secrets
import string
import config
import shutil
from flask import request, current_app, session, Response, render_template, \
    url_for
from flask_babel import gettext
from flask_security import login_user
from .internal import BaseAuthentication
from pgadmin.model import User
from pgadmin.tools.user_management import create_user, update_user
from pgadmin.utils.constants import WEBSERVER
from pgadmin.utils import PgAdminModule
from pgadmin.utils.csrf import pgCSRFProtect
from flask_security.utils import logout_user
from pgadmin.utils.master_password import set_crypt_key
from pgadmin.utils import load_database_servers
import logging

logger = logging.getLogger(__name__)


class WebserverModule(PgAdminModule):
    def register(self, app, options):
        # Do not look for the sub_modules,
        # instead call blueprint.register(...) directly
        super().register(app, options)

    def get_exposed_url_endpoints(self):
        return ['webserver.login',
                'webserver.logout']


def init_app(app):
    MODULE_NAME = 'webserver'

    blueprint = WebserverModule(MODULE_NAME, __name__, static_url_path='')

    @blueprint.route("/login",
                     endpoint="login", methods=["GET"])
    @pgCSRFProtect.exempt
    def webserver_login():
        logout_user()
        return Response(render_template("browser/kerberos_login.html",
                                        login_url=url_for('security.login'),
                                        ))

    @blueprint.route("/logout",
                     endpoint="logout", methods=["GET"])
    @pgCSRFProtect.exempt
    def webserver_logout():
        logout_user()
        return Response(render_template("browser/kerberos_logout.html",
                                        login_url=url_for('security.login'),
                                        ))

    app.register_blueprint(blueprint)


def copy_file(username, from_path, to_name):
    local_path = os.path.join(
        "/var/lib/pgadmin/storage",
        username.replace("@", "_"),
        to_name
    )

    # copy file from from_path to local_json_path
    if from_path and os.path.exists(from_path):
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        shutil.copyfile(from_path, local_path)


def change_permissions(username, filename, permissions):
    local_path = os.path.join(
        "/var/lib/pgadmin/storage",
        username.replace("@", "_"),
        filename
    )

    if os.path.exists(local_path):
        os.chmod(local_path, permissions)

def remove_file(username, filename):
    local_path = os.path.join(
        "/var/lib/pgadmin/storage",
        username.replace("@", "_"),
        filename
    )

    if os.path.exists(local_path):
        os.remove(local_path)


class WebserverAuthentication(BaseAuthentication):
    LOGIN_VIEW = 'webserver.login'
    LOGOUT_VIEW = 'webserver.logout'

    def get_source_name(self):
        return WEBSERVER

    def get_friendly_name(self):
        return gettext("webserver")

    def validate(self, form):
        return True, None

    def get_user(self):
        username = request.environ.get(config.WEBSERVER_REMOTE_USER)
        if not username:
            # One more try to get the Remote User from the hearders
            username = request.headers.get(config.WEBSERVER_REMOTE_USER)
        return username

    def authenticate(self, form):
        username = self.get_user()

        if not username:
            return False, gettext(
                "Webserver authenticate failed.")

        session['pass_enc_key'] = ''.join(
            (secrets.choice(string.ascii_lowercase) for _ in range(10)))

        useremail = request.environ.get('mail')
        if not useremail:
            useremail = ''
        return self.__auto_create_user(username, '')

    def login(self, form):
        username = self.get_user()
        if username:
            user = User.query.filter_by(username=username).first()
            status = login_user(user)
            if not status:
                current_app.logger.exception(self.messages('LOGIN_FAILED'))
                return False, self.messages('LOGIN_FAILED')
            current_app.logger.info(
                "Webserver user {0} logged in.".format(username))

            # After first login for webserver auth method, the user does not have email set
            # Since we are using email as the username, we need to update the user with proper email
            # This is also an opportunity to import server configurations for the user when he logs in first time
            if not user.email:
                update_success, update_msg = update_user(user.id, {'email': username})
                if update_success:
                    servers_json_path = os.environ.get('PGADMIN_SERVER_JSON_FILE')
                    passfile_path = os.environ.get('PGADMIN_PASSFILE_PATH')

                    copy_file(username, servers_json_path, "servers.json")
                    copy_file(username, passfile_path, "passfile")
                    change_permissions(username, "passfile", 0o600)

                    file_path = "servers.json"

                    if file_path and os.path.exists(file_path):
                        # Load the server configurations for the newly created user
                        current_app.logger.info(
                            "Importing server configurations for user {0} from {1}".format(
                                username, file_path))

                        # Import server configurations
                        import_success, import_msg = load_database_servers(
                            file_path, None, load_user=user)

                        if not import_success:
                            current_app.logger.error(
                                "Failed to import server configurations: {0}".format(import_msg))

                    remove_file(username, "servers.json")

            return True, None
        return False, self.messages('LOGIN_FAILED')

    def __auto_create_user(self, username, useremail):
        """Add the webserver user to the internal SQLite database."""
        if config.WEBSERVER_AUTO_CREATE_USER:
            user = User.query.filter_by(username=username).first()
            if not user:
                create_msg = ("Creating user {0} with email {1} "
                              "from auth source Webserver.")
                current_app.logger.info(create_msg.format(username,
                                                          useremail))
                return create_user({
                    'username': username,
                    'email': useremail,
                    'role': 2,
                    'active': True,
                    'auth_source': WEBSERVER
                })
        return True, None