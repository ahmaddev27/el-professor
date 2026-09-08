import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { startOfMonth, endOfMonth, eachDayOfInterval, getDay, addDays } from "npm:date-fns@4.1.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface WeekOfMonth {
  weekNumber: number;
  firstDay: Date;
  lastDay: Date;
}

function getWeeksOfMonth(date: Date): WeekOfMonth[] {
  const monthStart = startOfMonth(date);
  const monthEnd = endOfMonth(date);

  const allDays = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const mondays = allDays.filter(day => getDay(day) === 1);

  if (mondays.length === 0) {
    return [{
      weekNumber: 1,
      firstDay: monthStart,
      lastDay: monthEnd
    }];
  }

  const weeks: WeekOfMonth[] = mondays.map((monday, index) => {
    const nextMonday = mondays[index + 1];
    let lastDay: Date;

    if (nextMonday) {
      lastDay = addDays(nextMonday, -1);
    } else {
      lastDay = addDays(monday, 6);
    }

    return {
      weekNumber: index + 1,
      firstDay: monday,
      lastDay: lastDay
    };
  });

  return weeks;
}

function getWeekNumberForDate(date: Date): number {
  const weeks = getWeeksOfMonth(date);

  for (const week of weeks) {
    if (date >= week.firstDay && date <= week.lastDay) {
      return week.weekNumber;
    }
  }

  return 1;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    // Authenticate the caller and resolve their company_id — do NOT use service role
    // for data reads so RLS enforces tenant isolation automatically.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Use the caller's JWT — RLS will automatically scope to their company
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Optionally accept an explicit company_id for admin-scoped migrations
    let companyFilter: string | null = null;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body?.company_id) companyFilter = body.company_id;
      } catch (_) { /* no body */ }
    }

    let query = supabase
      .from("income")
      .select("id, date, description, company_id")
      .order("date", { ascending: true });

    if (companyFilter) {
      query = query.eq("company_id", companyFilter);
    }

    const { data: incomes, error: fetchError } = await query;

    if (fetchError) throw fetchError;

    let updated = 0;
    let failed = 0;

    for (const income of incomes || []) {
      try {
        const date = new Date(income.date);
        const weekNumber = getWeekNumberForDate(date);

        let newDescription = income.description;
        const weekPattern = /Woche \d+/i;
        if (weekPattern.test(newDescription)) {
          newDescription = newDescription.replace(weekPattern, `Woche ${weekNumber}`);
        } else {
          newDescription = `Woche ${weekNumber} - ${newDescription}`;
        }

        const { error: updateError } = await supabase
          .from("income")
          .update({
            week: weekNumber,
            description: newDescription
          })
          .eq("id", income.id);

        if (updateError) {
          console.error(`Failed to update income ${income.id}:`, updateError);
          failed++;
        } else {
          updated++;
        }
      } catch (err) {
        console.error(`Error processing income ${income.id}:`, err);
        failed++;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Updated ${updated} income records, ${failed} failed`,
        updated,
        failed,
        total: incomes?.length || 0
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err: any) {
    console.error("Error:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err.message
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
