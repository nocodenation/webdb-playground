import logging
import os

DEBUG = True

CONSOLE_LOG_LEVEL = logging.DEBUG
FILE_LOG_LEVEL = logging.DEBUG

CONFIG_DATABASE_URI = f"postgresql://postgres:{{ PGADMIN_DATABASE_PASSWORD }}@pgadmin_db:5432/postgres"