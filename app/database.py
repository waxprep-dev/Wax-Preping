def _get_engine():
    global _engine
    if _engine is None:
        settings = get_settings()
        db_url = settings.DATABASE_URL
        
        # FIX: asyncpg doesn't accept 'sslmode' as a keyword argument.
        # Parse the URL, extract ssl parameter, and pass it as connect_args.
        import urllib.parse
        parsed = urllib.parse.urlparse(db_url)
        query_params = urllib.parse.parse_qs(parsed.query)
        
        ssl_arg = False
        if 'ssl' in query_params:
            ssl_val = query_params['ssl'][0].lower()
            if ssl_val in ('require', 'true', 'yes', '1'):
                ssl_arg = True
            del query_params['ssl']
        
        # Rebuild the query string without ssl
        new_query = urllib.parse.urlencode(query_params, doseq=True)
        db_url = urllib.parse.urlunparse(parsed._replace(query=new_query))
        
        _engine = create_async_engine(
            db_url,
            echo=False,
            pool_size=5,
            max_overflow=10,
            pool_pre_ping=True,
            connect_args={"ssl": ssl_arg} if ssl_arg else {}
        )
    return _engine
