-- Expands roster_db (SQL Server 2005) from one team to all 30. Idempotent; safe to re-run.
-- Existing rows (Boston only) are tagged team = 'BOS'. Run after migrate-seasons.sql.
USE roster_db;
GO
-- teams reference (abbr, display name, logo URL, ESPN id, nbaapi abbreviation)
IF OBJECT_ID('dbo.teams') IS NULL
CREATE TABLE dbo.teams (
    abbr        VARCHAR(5) PRIMARY KEY,
    name        NVARCHAR(60),
    logo        VARCHAR(200),
    espn_id     INT,
    nbaapi_abbr VARCHAR(5)
);
GO
-- players.team
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.players') AND name = 'team')
    ALTER TABLE dbo.players ADD team VARCHAR(5) NULL;
GO
UPDATE dbo.players SET team = 'BOS' WHERE team IS NULL;
GO
IF EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_players_season_name' AND parent_object_id = OBJECT_ID('dbo.players'))
    ALTER TABLE dbo.players DROP CONSTRAINT UQ_players_season_name;
GO
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_players_season_team_name' AND parent_object_id = OBJECT_ID('dbo.players'))
    ALTER TABLE dbo.players ADD CONSTRAINT UQ_players_season_team_name UNIQUE (season, team, name);
GO
-- schedule_info.team: one row per (season, team); drop the old id primary key and season-only index
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.schedule_info') AND name = 'team')
    ALTER TABLE dbo.schedule_info ADD team VARCHAR(5) NULL;
GO
UPDATE dbo.schedule_info SET team = 'BOS' WHERE team IS NULL;
GO
DECLARE @pk SYSNAME;
SET @pk = (SELECT name FROM sys.key_constraints WHERE parent_object_id = OBJECT_ID('dbo.schedule_info') AND type = 'PK');
IF @pk IS NOT NULL EXEC('ALTER TABLE dbo.schedule_info DROP CONSTRAINT [' + @pk + ']');
GO
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.schedule_info') AND name = 'id' AND is_nullable = 0)
    ALTER TABLE dbo.schedule_info ALTER COLUMN id INT NULL;
GO
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_schedule_season' AND object_id = OBJECT_ID('dbo.schedule_info'))
    DROP INDEX UX_schedule_season ON dbo.schedule_info;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_schedule_season_team' AND object_id = OBJECT_ID('dbo.schedule_info'))
    CREATE UNIQUE INDEX UX_schedule_season_team ON dbo.schedule_info(season, team);
GO
-- read access for the web app
GRANT SELECT ON dbo.teams TO nbahub_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.teams TO nbahub_feeder;
GO
SELECT 'players' AS t, season, team, COUNT(*) AS n FROM dbo.players GROUP BY season, team
UNION ALL SELECT 'teams', NULL, NULL, COUNT(*) FROM dbo.teams
ORDER BY t, season, team;
GO
