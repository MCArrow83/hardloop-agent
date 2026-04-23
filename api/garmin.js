// api/garmin.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { jwtWeb, sessionId, workouts } = req.body || {};
  if (!jwtWeb || !sessionId || !workouts?.length) {
    return res.status(400).json({ error: "jwtWeb, sessionId en workouts zijn verplicht" });
  }

  const cookieString = `JWT_WEB=${jwtWeb}; SESSIONID=${sessionId}`;
  const headers = {
    "Cookie": cookieString,
    "NK": "NT",
    "X-App-Ver": "4.73.1.0",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Origin": "https://connect.garmin.com",
    "Referer": "https://connect.garmin.com/modern/workout/create/running"
  };

  // Test sessie eerst
  try {
    const test = await fetch("https://connect.garmin.com/workout-service/workouts?start=1&limit=1", { headers });
    if (test.status === 401 || test.status === 403) {
      return res.status(200).json({ 
        success: false, 
        error: `Sessie verlopen (${test.status}) — open de Garmin knop en plak nieuwe cookies` 
      });
    }
  } catch(e) {}

  let uploaded = 0;
  const errors = [];

  for (const workout of workouts) {
    try {
      const workoutId = await createWorkout(headers, workout);
      if (workout.scheduledDate) await scheduleWorkout(headers, workoutId, workout.scheduledDate);
      uploaded++;
    } catch (e) {
      errors.push(e.message);
    }
  }

  return res.status(200).json({ 
    success: uploaded > 0, 
    uploaded, 
    errors,
    error: uploaded === 0 ? errors[0] : undefined
  });
}

async function createWorkout(headers, workout) {
  const sportTypeMap = {
    running:           { sportTypeId: 1,  sportTypeKey: "running" },
    cycling:           { sportTypeId: 2,  sportTypeKey: "cycling" },
    swimming:          { sportTypeId: 5,  sportTypeKey: "swimming" },
    strength_training: { sportTypeId: 4,  sportTypeKey: "strength_training" },
    cardio:            { sportTypeId: 26, sportTypeKey: "cardio" },
    yoga:              { sportTypeId: 43, sportTypeKey: "yoga" },
    walking:           { sportTypeId: 3,  sportTypeKey: "walking" }
  };
  const stepTypeMap = { warmup: 1, cooldown: 2, interval: 3, recovery: 4, rest: 5, other: 7 };
  const sport = sportTypeMap[workout.sport] || sportTypeMap.running;

  const steps = (workout.steps || []).map((step, i) => {
    const s = {
      stepId: i + 1, stepOrder: i + 1,
      stepType: { stepTypeId: stepTypeMap[step.type] || 3, stepTypeKey: step.type || "interval" },
      endCondition: {
        conditionTypeId: step.durationType === "distance" ? 3 : 2,
        conditionTypeKey: step.durationType === "distance" ? "distance" : "time",
        conditionValue: step.durationValue || 600, conditionValueType: null
      },
      endConditionValue: step.durationValue || 600
    };
    if (step.target?.type === "heart.rate.zone") {
      s.targetType = { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" };
      s.targetValueOne = step.target.zoneNumber || 2;
      s.targetValueTwo = null;
    } else {
      s.targetType = { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" };
      s.targetValueOne = null; s.targetValueTwo = null;
    }
    return s;
  });

  const body = {
    sportType: sport, subSportType: null,
    workoutName: workout.workoutName || "Training",
    description: workout.description || "",
    estimatedDurationInSecs: steps.reduce((a, s) => a + (s.endConditionValue || 0), 0),
    estimatedDistanceInMeters: null,
    workoutSegments: [{ segmentOrder: 1, sportType: sport, workoutSteps: steps }]
  };

  const resp = await fetch("https://connect.garmin.com/workout-service/workout", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => String(resp.status));
    throw new Error(`Workout mislukt (${resp.status}): ${err.slice(0, 150)}`);
  }
  const data = await resp.json();
  return data.workoutId;
}

async function scheduleWorkout(headers, workoutId, date) {
  const resp = await fetch(`https://connect.garmin.com/workout-service/schedule/${workoutId}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ date })
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => String(resp.status));
    throw new Error(`Inplannen mislukt (${resp.status}): ${err.slice(0, 80)}`);
  }
  return true;
}
