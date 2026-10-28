-- Per-season statistical award winners (MVP + category leaders). Idempotent. Run after migrate-teams.sql.
USE roster_db;
GO
IF OBJECT_ID('dbo.leaders') IS NULL
CREATE TABLE dbo.leaders (
    season   INT,
    ord      INT,                 -- display order (MVP, Points, Rebounds, Assists, Steals, Blocks)
    category VARCHAR(20),
    name     NVARCHAR(100),
    team     VARCHAR(10),
    value    VARCHAR(30)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_leaders' AND object_id = OBJECT_ID('dbo.leaders'))
    CREATE UNIQUE INDEX UX_leaders ON dbo.leaders(season, category);
GO
GRANT SELECT ON dbo.leaders TO nbahub_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.leaders TO nbahub_feeder;
GO
