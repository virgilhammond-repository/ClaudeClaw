---
name: timezone
description: Show current times across key locations. Use when the user says "timezone", "what time is it", "team times", "check the time in", or wants to know working hours.
---

# Timezone Dashboard

Show current times for key locations. Run this bash command and display the results in a clean table:

```bash
echo "---"
echo "Location         | Timezone              | Local Time"
echo "---"
for tz in "New York:America/New_York" "London:Europe/London" "Dubai:Asia/Dubai" "Tokyo:Asia/Tokyo" "Sydney:Australia/Sydney"; do
  IFS=':' read -r label zone <<< "$tz"
  time=$(TZ="$zone" date +"%I:%M %p (%a)")
  printf "%-16s | %-21s | %s\n" "$label" "$zone" "$time"
done
echo "---"
```

Format the output as a clean table. After the table, add a one-line note about which locations are likely in working hours (9am-6pm local) right now.

Customize this skill by editing the timezone list above to match your team's locations.
