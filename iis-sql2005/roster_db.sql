-- roster_db for SQL Server 2005 (port of the Postgres init.sql). Placeholder @FEEDER_PW@ is filled in at deploy.
IF DB_ID('roster_db') IS NULL CREATE DATABASE roster_db COLLATE SQL_Latin1_General_CP1_CI_AS;
GO
USE roster_db;
GO
IF OBJECT_ID('dbo.players') IS NULL
CREATE TABLE dbo.players (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    num           VARCHAR(5),
    season        INT,
    team          VARCHAR(5),
    name          NVARCHAR(100) NOT NULL,
    pos           VARCHAR(10),
    ppg           VARCHAR(10) DEFAULT '0.0',
    rpg           VARCHAR(10) DEFAULT '0.0',
    apg           VARCHAR(10) DEFAULT '0.0',
    spg           VARCHAR(10) DEFAULT '0.0',
    bpg           VARCHAR(10) DEFAULT '0.0',
    fgp           VARCHAR(10) DEFAULT '0.0',
    tpp           VARCHAR(10) DEFAULT '0.0',
    ftp           VARCHAR(10) DEFAULT '0.0',
    gp            VARCHAR(5)  DEFAULT '0',
    mpg           VARCHAR(10) DEFAULT '0.0',
    injury        NVARCHAR(100),
    injury_detail NVARCHAR(300),
    espn_id       VARCHAR(20),
    photo         VARCHAR(200),
    updated_at    DATETIME,
    CONSTRAINT UQ_players_season_team_name UNIQUE (season, team, name)
);
GO
IF OBJECT_ID('dbo.leaders') IS NULL
CREATE TABLE dbo.leaders (
    season   INT,
    ord      INT,
    category VARCHAR(20),
    name     NVARCHAR(100),
    team     VARCHAR(10),
    value    VARCHAR(30)
);
GO
IF OBJECT_ID('dbo.teams') IS NULL
CREATE TABLE dbo.teams (
    abbr        VARCHAR(5) PRIMARY KEY,
    name        NVARCHAR(60),
    logo        VARCHAR(200),
    espn_id     INT,
    nbaapi_abbr VARCHAR(5)
);
GO
IF OBJECT_ID('dbo.mvp_contenders') IS NULL
CREATE TABLE dbo.mvp_contenders (
    id     INT IDENTITY(1,1) PRIMARY KEY,
    season INT,
    [rank] INT,
    name   NVARCHAR(100),
    team   VARCHAR(10),
    ppg    VARCHAR(10),
    rpg    VARCHAR(10),
    apg    VARCHAR(10)
);
GO
-- /api/schedule was a live ESPN call in the Node app; the feeder now stores it here (single row, id = 1)
IF OBJECT_ID('dbo.schedule_info') IS NULL
CREATE TABLE dbo.schedule_info (
    id            INT PRIMARY KEY,
    played        INT,
    remaining     INT,
    playoff_start VARCHAR(20),
    last_games    NVARCHAR(MAX),
    updated_at    DATETIME,
    season        INT,
    team          VARCHAR(5)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_schedule_season_team' AND object_id = OBJECT_ID('dbo.schedule_info'))
    CREATE UNIQUE INDEX UX_schedule_season_team ON dbo.schedule_info(season, team);
GO
-- Seed (same as init.sql; the feeder overwrites with live values)
IF NOT EXISTS (SELECT 1 FROM dbo.players)
INSERT INTO dbo.players (season, team, num, name, pos, ppg, rpg, apg, espn_id)
SELECT 2026, 'BOS', '7',  N'Jaylen Brown',      'F/G', '29.5', '7.0', '4.7', '3917376' UNION ALL
SELECT 2026, 'BOS', '0',  N'Jayson Tatum',      'F',   '18.4', '10.8','5.4', '4065648' UNION ALL
SELECT 2026, 'BOS', '9',  N'Derrick White',     'G',   '17.4', '4.5', '5.5', '3062679' UNION ALL
SELECT 2026, 'BOS', '11', N'Payton Pritchard',  'G',   '17.3', '4.2', '5.3', '4066349' UNION ALL
SELECT 2026, 'BOS', '30', N'Sam Hauser',        'F',   '9.0',  '3.8', '1.4', '4066421' UNION ALL
SELECT 2026, 'BOS', '88', N'Neemias Queta',     'C',   '9.9',  '8.4', '1.5', '4432165' UNION ALL
SELECT 2026, 'BOS', '55', N'Baylor Scheierman', 'G',   '3.6',  '2.5', '0.9', '4431741' UNION ALL
SELECT 2026, 'BOS', '27', N'Jordan Walsh',      'F',   '5.5',  '4.3', '0.8', '4683777' UNION ALL
SELECT 2026, 'BOS', '52', N'Luka Garza',        'C',   '5.1',  '3.8', '0.6', '4278060' UNION ALL
SELECT 2026, 'BOS', '28', N'Hugo Gonz' + NCHAR(225) + N'lez', 'F', '3.9', '3.4', '0.6', '5105088' UNION ALL
SELECT 2026, 'BOS', '13', N'Ron Harper Jr.',    'F',   '6.2',  '3.8', '0.9', '4432805';
GO
-- Web app: IIS app pool identity, read-only
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'IIS APPPOOL\NbaHub')
    CREATE LOGIN [IIS APPPOOL\NbaHub] FROM WINDOWS WITH DEFAULT_DATABASE = roster_db;
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'nbahub_web')
    CREATE USER nbahub_web FOR LOGIN [IIS APPPOOL\NbaHub];
GRANT SELECT ON dbo.players TO nbahub_web;
GRANT SELECT ON dbo.mvp_contenders TO nbahub_web;
GRANT SELECT ON dbo.schedule_info TO nbahub_web;
GRANT SELECT ON dbo.teams TO nbahub_web;
GRANT SELECT ON dbo.leaders TO nbahub_web;
GO
-- Feeder (the container in ../feeder): SQL login, data read/write only
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'nbahub_feeder')
    CREATE LOGIN nbahub_feeder WITH PASSWORD = N'@FEEDER_PW@', DEFAULT_DATABASE = roster_db, CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;
ELSE
    ALTER LOGIN nbahub_feeder WITH PASSWORD = N'@FEEDER_PW@';
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'nbahub_feeder')
    CREATE USER nbahub_feeder FOR LOGIN nbahub_feeder;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.players TO nbahub_feeder;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.mvp_contenders TO nbahub_feeder;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.schedule_info TO nbahub_feeder;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.teams TO nbahub_feeder;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.leaders TO nbahub_feeder;
GO
SELECT 'players' AS t, COUNT(*) AS n FROM dbo.players UNION ALL SELECT 'logins', COUNT(*) FROM sys.server_principals WHERE name IN (N'IIS APPPOOL\NbaHub', N'nbahub_feeder');
GO
