
const fs = require('fs');
const axios = require('axios');
const config = require('./config.json')

const formID = config.formID;
const configuredEvents = config.events;
const qStartET = config.form.startETID;
const qMatchup = config.form.matchupID;
const qRound = config.form.roundID;
const qRestreamConsent = config.form.consentID;

let trackedRaceIds = {};

const waitMS = ms => new Promise(res => setTimeout(res, ms));

// 1) Load/Save state to track previously added race IDs
function loadTrackedRaceIds() {
    try {
        const data = fs.readFileSync('state.json', 'utf8');
        trackedRaceIds = JSON.parse(data).trackedRaceIds || {};
    } catch (error) {
        console.warn('Could not load state.json, starting fresh...', error.message);
        trackedRaceIds = {};
    }
}

function saveTrackedRaceIds(eventName, eventRaceIds) {
    trackedRaceIds[eventName] = eventRaceIds;
    const data = JSON.stringify({ trackedRaceIds: Array.from(trackedRaceIds) }, null, 2);
    fs.writeFileSync('state.json', data);
}

// 2) Fetch series (by name) from the midos.house GraphQL API
async function fetchSeries(seriesName, eventName) {
    const query = `
        query {
            series(name: "${seriesName}") {
                event(name: "${eventName}") {
                    races {
                        id
                        start
                        round
                        restreamConsent
                        teams {
                            members {
                                user {
                                    displayName
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    const response = await axios.post('https://midos.house/api/v1/graphql',
        { query },
        {
            headers: {
                'X-API-Key': config.midosAPIKey,
                'Content-Type': 'application/json'
            }
        }
    );

    return response?.data?.data?.series;
}

// 3) Convert UTC to ET (DST-aware) and then return in date answer URL format
function parseEtToDateTimeFormat(utcString) {
    const dateEt = new Date(
        new Date(utcString).toLocaleString('en-US', { timeZone: 'America/New_York' })
    );

    let monthFull = (dateEt.getMonth() + 1 < 10) ? "0" + (dateEt.getMonth() + 1) : dateEt.getMonth() + 1
    let dayFull = (dateEt.getDate() < 10) ? "0" + dateEt.getDate() : dateEt.getDate();
    let hoursFull = (dateEt.getHours() < 10) ? "0" + dateEt.getHours() : dateEt.getHours();
    let minutesFull = (dateEt.getMinutes() < 10) ? "0" + dateEt.getMinutes() : dateEt.getMinutes();

    return `${dateEt.getFullYear()}-${monthFull}-${dayFull}+${hoursFull}:${minutesFull}`;
}

// 4) Main function: fetch races, convert times, submit each as a new Form response
async function addRacesToForm(eventToAdd, eventRaceIds) {
    try {
        const seriesData = await fetchSeries(eventToAdd.seriesName, eventToAdd.eventName);
        if (!seriesData) {
            console.log(`No series found for "${eventToAdd.seriesName}/${eventToAdd.eventName}".`);
            return;
        }

        for (const race of seriesData.event.races) {
            if (eventRaceIds.has(race.id))
                continue; // skip if already tracked

            if (new Date(race.start).getTime() < new Date().getTime()) // skip if race is in the past
                continue;

            // Mark it tracked
            eventRaceIds.add(race.id);

            // Convert time
            const dateTimeString = parseEtToDateTimeFormat(race.start);

            // Format matchup: assume 2 teams, each with 1 member
            let matchup = '';
            if (race.teams && race.teams.length === 2) {
                const [teamA, teamB] = race.teams;
                const playerA = teamA?.members?.[0]?.user?.displayName || '???';
                const playerB = teamB?.members?.[0]?.user?.displayName || '???';
                matchup = `${playerA}+vs.+${playerB}`;
            }

            if (eventToAdd.overrideMatchUpString.length > 0)
                matchup = eventToAdd.overrideMatchUpString;

            let roundString = race.round;

            if (eventToAdd.roundPrefix.length > 0)
                roundString = `${eventToAdd.roundPrefix.replace(/\s/g,"+")}:+${race.round.replace(/\s/g,"+")}`;

            let consentString = (race.restreamConsent == "true" || race.restreamConsent == null) ? "Yes" : "No"; // null set for big races

            // Unfortunately, the Google Forms API does currently not allow submission of responses through the API, so the only workaround is to use the formResponse endpoint with prefilled form fields
            let submissionLink = `https://docs.google.com/forms/d/e/${formID}/formResponse?&submit=Submit&usp=pp_url&entry.${qStartET}=${dateTimeString}&entry.${qMatchup}=${matchup}&entry.${qRound}=${roundString}&entry.${qRestreamConsent}=${consentString}`;

            await axios.get(submissionLink);
            console.log(`Submitted race ${race.id} of ${eventToAdd.seriesName}/${eventToAdd.eventName}: ${matchup} at ${dateTimeString}`);

            // Bit of rate limiting
            await waitMS(1000);
        }

    } catch (error) {
        console.error('Error adding races to form:', error.message);
    }
}

// 5) Run periodically (every 10 minutes)
async function refreshEventRaces() {
    
    for (var i=0; i<= configuredEvents.length; i++) {
        let eventToAdd = configuredEvents[i];
    
        let eventRaceIds;
        console.log(`${eventToAdd.seriesName}/${eventToAdd.eventName}`, trackedRaceIds);
        if (!(`${eventToAdd.seriesName}/${eventToAdd.eventName}` in trackedRaceIds))
            eventRaceIds = new Set();
        else eventRaceIds = new Set(trackedRaceIds[`${eventToAdd.seriesName}/${eventToAdd.eventName}`]);

        await addRacesToForm(eventToAdd, eventRaceIds)

        // Save updated state for this event
        saveTrackedRaceIds(`${eventToAdd.seriesName}/${eventToAdd.eventName}`, eventRaceIds);

        await waitMS(2000);
    }
}

// Run on startup, then every 10 minutes
loadTrackedRaceIds();
refreshEventRaces();

setInterval(refreshEventRaces, 10 * 60000);