
const fs = require('fs');
const axios = require('axios');
const config = require('./config.json')

const formID = config.formID;
const seriesName = config.seriesName;
const eventName = config.eventName
const qStartET = config.form.startETID;
const qMatchup = config.form.matchupID;
const qRound = config.form.roundID;
const qRestreamConsent = config.form.consentID;

const waitMS = ms => new Promise(res => setTimeout(res, ms));

// 1) Load/Save state to track previously added race IDs
function loadTrackedRaceIds() {
    try {
        const data = fs.readFileSync('state.json', 'utf8');
        return new Set(JSON.parse(data).trackedRaceIds || []);
    } catch (error) {
        console.warn('Could not load state.json, starting fresh...', error.message);
        return new Set();
    }
}

function saveTrackedRaceIds(trackedRaceIds) {
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
async function addRacesToForm(seriesName, eventName, trackedRaceIds) {
    try {
        const seriesData = await fetchSeries(seriesName, eventName);
        if (!seriesData) {
            console.log(`No series found for "${seriesName}/${eventName}".`);
            return;
        }

        for (const race of seriesData.event.races) {
            if (trackedRaceIds.has(race.id))
                continue; // skip if already tracked

            if (new Date(race.start).getTime() < new Date().getTime()) // skip if race is in the past
                continue;

            // Mark it tracked
            trackedRaceIds.add(race.id);

            // Convert time
            const dateTimeString = parseEtToDateTimeFormat(race.start);

            // Format matchup: assume 2 teams, each with 1 member
            let matchup = 'Unknown matchup';
            if (race.teams.length === 2) {
                const [teamA, teamB] = race.teams;
                const playerA = teamA?.members?.[0]?.user?.displayName || '???';
                const playerB = teamB?.members?.[0]?.user?.displayName || '???';
                matchup = `${playerA}+vs.+${playerB}`;
            }

            let roundString = race.round;

            if (config.roundPrefix.length > 0)
                roundString = `${config.roundPrefix.replace(/\s/g,"+")}:+${race.round.replace(/\s/g,"+")}`;

            let consentString = race.restreamConsent ? "Yes" : "No";

            // Unfortunately, the Google Forms API does currently not allow submission of responses through the API, so the only workaround is to use the formResponse endpoint with prefilled form fields
            let submissionLink = `https://docs.google.com/forms/d/e/${formID}/formResponse?&submit=Submit&usp=pp_url&entry.${qStartET}=${dateTimeString}&entry.${qMatchup}=${matchup}&entry.${qRound}=${roundString}&entry.${qRestreamConsent}=${consentString}`;

            await axios.get(submissionLink);
            console.log(`Submitted race ${race.id}: ${matchup} at ${dateTimeString}`);

            // Bit of rate limiting
            await waitMS(2000);
        }

    } catch (error) {
        console.error('Error adding races to form:', error.message);
    }
}

// 5) Run periodically (every 10 minutes)
async function refreshEventRaces() {
    const trackedRaceIds = loadTrackedRaceIds();

    await addRacesToForm(seriesName, eventName, trackedRaceIds);

    // Save updated state
    saveTrackedRaceIds(trackedRaceIds);
}

// Run on startup, then every 10 minutes
refreshEventRaces();
setInterval(refreshEventRaces, 10 * 60000);