// NBA Hub API for IIS 7.5 / ASP.NET 2.0-3.5 (compiled on the fly from App_Code; C# 2.0 syntax).
// Same JSON shapes as the original Node/Express backend. Read-only: the feeder on .8 writes the data.
using System;
using System.Collections.Generic;
using System.Configuration;
using System.Data.SqlClient;
using System.Web;
using System.Web.Script.Serialization;

namespace NbaHub
{
    public abstract class JsonHandler : IHttpHandler
    {
        public bool IsReusable { get { return true; } }
        protected abstract object Build();

        public void ProcessRequest(HttpContext ctx)
        {
            ctx.Response.ContentType = "application/json";
            ctx.Response.Cache.SetCacheability(HttpCacheability.NoCache);
            JavaScriptSerializer js = new JavaScriptSerializer();
            try { ctx.Response.Write(js.Serialize(Build())); }
            catch (Exception e)
            {
                ctx.Response.StatusCode = 500;
                ctx.Response.TrySkipIisCustomErrors = true;   // keep our JSON instead of IIS's HTML error page
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["error"] = e.Message;
                ctx.Response.Write(js.Serialize(err));
            }
        }

        protected static List<Dictionary<string, object>> Query(string sql)
        {
            List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
            using (SqlConnection cn = new SqlConnection(ConfigurationManager.ConnectionStrings["roster"].ConnectionString))
            using (SqlCommand cmd = new SqlCommand(sql, cn))
            {
                cn.Open();
                using (SqlDataReader r = cmd.ExecuteReader())
                {
                    while (r.Read())
                    {
                        Dictionary<string, object> row = new Dictionary<string, object>();
                        for (int i = 0; i < r.FieldCount; i++)
                            row[r.GetName(i)] = r.IsDBNull(i) ? null : r.GetValue(i);
                        rows.Add(row);
                    }
                }
            }
            return rows;
        }

        // The season filter is an integer parsed from ?season=; falls back to the newest season in that table.
        protected static string SeasonFilter(string table)
        {
            string raw = HttpContext.Current.Request.QueryString["season"];
            int season;
            if (int.TryParse(raw, out season)) return season.ToString();
            return "(SELECT MAX(season) FROM dbo." + table + ")";
        }

        // Optional team filter from ?team= (abbreviation, letters only). Empty string = no filter.
        protected static string TeamClause()
        {
            string t = HttpContext.Current.Request.QueryString["team"];
            if (string.IsNullOrEmpty(t)) return "";
            string safe = System.Text.RegularExpressions.Regex.Replace(t, "[^A-Za-z]", "").ToUpper();
            return safe.Length == 0 ? "" : " AND team = '" + safe + "'";
        }
    }

    public class RosterHandler : JsonHandler
    {
        protected override object Build()
        {
            // Order by games played then name: jersey numbers are blank for past seasons, so CAST(num) is unsafe.
            return Query("SELECT id, season, team, num, name, pos, ppg, rpg, apg, spg, bpg, fgp, tpp, ftp, gp, mpg, injury, injury_detail, espn_id, photo " +
                         "FROM dbo.players WHERE season = " + SeasonFilter("players") + TeamClause() +
                         " ORDER BY CAST(gp AS INT) DESC, name");
        }
    }

    // Per-season statistical award winners (MVP + category leaders), in display order.
    public class LeadersHandler : JsonHandler
    {
        protected override object Build()
        {
            return Query("SELECT category, name, team, value FROM dbo.leaders WHERE season = " + SeasonFilter("leaders") + " ORDER BY ord");
        }
    }

    // Teams that have a roster in the given season, with name + logo, for the team grid.
    public class TeamsHandler : JsonHandler
    {
        protected override object Build()
        {
            string season = SeasonFilter("players");
            return Query("SELECT t.abbr, t.name, t.logo FROM dbo.teams t " +
                         "WHERE t.abbr IN (SELECT DISTINCT team FROM dbo.players WHERE season = " + season + ") ORDER BY t.name");
        }
    }

    public class MvpHandler : JsonHandler
    {
        protected override object Build()
        {
            return Query("SELECT id, season, [rank], name, team, ppg, rpg, apg FROM dbo.mvp_contenders WHERE season = " + SeasonFilter("mvp_contenders") + " ORDER BY [rank]");
        }
    }

    // Distinct seasons available (newest first), with the current (max) one flagged, for the year dropdown.
    public class SeasonsHandler : JsonHandler
    {
        protected override object Build()
        {
            List<Dictionary<string, object>> rows = Query("SELECT DISTINCT season FROM dbo.players WHERE season IS NOT NULL ORDER BY season DESC");
            List<object> seasons = new List<object>();
            int current = 0;
            foreach (Dictionary<string, object> r in rows)
            {
                int y = Convert.ToInt32(r["season"]);
                if (current == 0) current = y;
                Dictionary<string, object> o = new Dictionary<string, object>();
                o["season"] = y;
                o["label"] = (y - 1).ToString() + "-" + (y % 100).ToString("D2");  // 2027 -> "2026-27"
                seasons.Add(o);
            }
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["current"] = current;
            result["seasons"] = seasons;
            return result;
        }
    }

    public class ScheduleHandler : JsonHandler
    {
        protected override object Build()
        {
            List<Dictionary<string, object>> rows = Query("SELECT played, remaining, playoff_start, last_games, updated_at FROM dbo.schedule_info WHERE season = " + SeasonFilter("schedule_info") + TeamClause());
            Dictionary<string, object> o = new Dictionary<string, object>();
            if (rows.Count == 0) throw new Exception("schedule not synced yet");
            Dictionary<string, object> s = rows[0];
            o["played"] = s["played"];
            o["remaining"] = s["remaining"];
            o["playoffStart"] = s["playoff_start"] ?? "TBD";
            o["lastGames"] = s["last_games"] == null ? new object[0] : new JavaScriptSerializer().DeserializeObject((string)s["last_games"]);
            o["updatedAt"] = s["updated_at"];
            return o;
        }
    }

    public class HealthHandler : JsonHandler
    {
        protected override object Build()
        {
            List<Dictionary<string, object>> r = Query("SELECT @@VERSION AS sql_version, (SELECT COUNT(*) FROM dbo.players) AS players, " +
                "(SELECT MAX(updated_at) FROM dbo.schedule_info) AS last_sync");
            r[0]["iis"] = HttpContext.Current.Request.ServerVariables["SERVER_SOFTWARE"];
            r[0]["aspnet"] = Environment.Version.ToString();
            return r[0];
        }
    }
}
