FROM oven/bun:latest

RUN mkdir /app
RUN mkdir /build_info

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /app

ENTRYPOINT ["/entrypoint.sh"]
