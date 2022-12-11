import { access, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'node-html-parser';
import ical from "ical-generator";
import {default as ical2} from "node-ical" ;
import http from "http";
import { schedule } from "node-cron";
import { Webhook } from "discord-webhook-node";
import { Client, GatewayIntentBits, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from "discord.js";
import puppeteer from 'puppeteer';
import got from 'got';


const CONFIG = JSON.parse(readFileSync('config.json', 'utf-8'));
let MODULES;
if (existsSync('modules.cache')) {
    MODULES = JSON.parse(readFileSync('modules.cache', 'utf-8'));
} else {
    MODULES = {}
}

if (CONFIG.WEBHOOK) {
    const hook = new Webhook(CONFIG.WEBHOOK)
};

const client = new Client({ intents: [GatewayIntentBits.Guilds]});

// Convert date to ISO 8601 : 2022-10-25
// date : "25/10/2022"
function fixDate(date) {
    date = date.text.split("/");
    date = `${date[2]}-${date[1]}-${date[0]}`;
    
    if (CONFIG.DEBUG) console.log(`fixDate: ${date}`);
    
    return date;
}

// Manually convert date and time strings to ISO 8601
// date : ISO 8601
// time : "9.00 - 12.00"
// index : time index
function fixDateTime(date, time, index) {
    time = time.text.split("-");
    var datetime = `${date}T${('0'+time[index].replace(".",":").replace(" ","")).slice(-5)}`; // ISO8601 : 2022-10-25T09:00
    
    if (CONFIG.DEBUG) console.log(`fixDateTime: ${datetime}`);
    
    return new Date(datetime);
}

// Return a list of all the events
// res : raw html response
async function getPlanning(res) {
    var planning = [];
    
    // Convert response into a dom object
    const dom = parse(res);
    var cells = dom.querySelectorAll(".PlanningCellMonth");
    
    // Make sure we fetch some cells
    if (cells.length === 0) {
        console.log("Could not get cells");
        return 0; 
    }
    
    // Get events for each cell (day)
    for (let cell of cells) {
        let events = cell.querySelectorAll(".UniteContainer");
        if (events == 0) continue; // Skip if the day is empty
        
        let date = fixDate(cell.querySelector(".JourInfo"));
        
        for (let event of events) {
            let time = event.querySelector(".UniteTime");
            planning.push({
                date: date,
                startTime: fixDateTime(date, time, 0),
                endTime: fixDateTime(date, time, 1),
                classroom: event.querySelector(".UniteSalle").text,
                name: event.querySelector(".UniteNom").text,
                type: event.querySelector(".UniteType").text,
                teacher: event.querySelector(".UniteEnseignant").text
            });
        }
        
    }
    
    return planning;
}

// Fetches and caches module names from the CNAM public database
async function getModuleName(mname) {
    if (MODULES[mname] !== undefined) return MODULES[mname];

    console.log(`Module ${mname} unknown. Fetching.`)
    const req = await got.get(`https://bedeo.cnam.fr/public/unite/view/${mname}`)
    
    if(req.statusCode !== 200) {
        console.log(`Cannot get module name. Defaulting to ${mname}`)
        return mname;
    }

    let fullname = parse(req.body).querySelectorAll(".lead")[0].innerHTML.replace(/ [0-9]/g, "");
    fullname = fullname.replace("&#039;", "'"); // Quick fix TODO: Proper
    
    console.log(fullname);
    MODULES[mname] = fullname;

    writeFileSync("modules.cache", JSON.stringify(MODULES));
}

// Build iCal from planning data
// data : list of events
async function getCalendar(data) {
    const calendar = ical({name: "Planning CNAM"})
    
    for (let event of data) {
        calendar.createEvent({
            start: event.startTime,
            end: event.endTime,
            summary: await getModuleName(event.name),
            description: `${event.name} - ${event.type}`,
            location: `${event.teacher} - ${event.classroom}`,
            id: event.startTime.getTime(),
            timezone: "Europe/Paris"
        });
    }
    
    return calendar;
}

// Fetch the planning using puppeteer
// Note: ASPNET is managing the view switch and is tedious to work around
async function fetchPlanning() {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
  
    const req = await page.goto(CONFIG.URL);

    if (req.status() !== 200) {
        await browser.close();
        hook.send(`Couldn't fetch the page. HTTP CODE ${req.status()}`); // TODO: Proper discord errors
        throw `Couldn't fetch the page. HTTP CODE ${req.status()}`;
    }
    if (CONFIG.DEBUG) console.log(`statusCode : ${req.status()}`);
    
    // Wait for button to be available
    const viewByYear = '#m_c_planning_pPlanning_btnViewByYear';
    await page.waitForSelector(viewByYear);
    await page.click(viewByYear);

    // Wait for cursor to go back to normal (done loading)
    await page.waitForFunction('document.body.style.cursor == "auto"')
    const body = await page.content();

    // End session
    await browser.close();

    if (CONFIG.DEBUG) writeFileSync("debug.html", body);

    return body;
}

// Main func : Create calendar.ics file
async function main() {
    console.log("Fetching planning page");
    const body = await fetchPlanning();
    
    console.log("Got planning data, parsing.")
    const planning = await getPlanning(body);
    if (CONFIG.DEBUG) { 
        console.log("Got planning object :");
        console.log(planning);
    }
    if (planning == 0) {
        console.log("Planning is empty");
        hook.send("Planning is empty"); // TODO: Proper discord errors
        return;
    }
    
    console.log(`Found ${planning.length} event(s), building iCal.`);
    const cal = await getCalendar(planning);
    if (CONFIG.DEBUG) {
        console.log("Built calendar :");
        console.log(cal);
    }
    
    console.log("Writing calendar.ics");
    await cal.save("./calendar.ics");

    console.log("Starting Discord Events refresh")
    refreshEvents();
}

// Refresh discord events
async function refreshEvents() {
    const guild = await client.guilds.fetch("1027180729618141184"); 
    const events = await guild.scheduledEvents.fetch();
    
    const calendar = Object.values(ical2.sync.parseFile('calendar.ics'));
    calendar.pop();

    // Building the list of event to add
    // Limits the number of events because of Discord limits
    let toAdd = [];
    calendar.some(event => {
        if (event.start < new Date()) return;
        toAdd.push(event);
        if (toAdd.length > 49) return true;
    });

    if (CONFIG.DEBUG) console.log(toAdd);
    
    //Compare events
    for (let event of events) {
        event = event[1];
        let existing = toAdd.find(i => i.start.getTime() === event.scheduledStartAt.getTime());
        if (existing === undefined) {
            console.log("Event does not exist, removing...");
            event.delete();
            events.delete(event.id);
            continue;
        };
        if (existing.summary !== event.name || existing.location !== event.entityMetadata.location || existing.description !== event.description) {
            console.log("Event values don't match, removing...");
            event.delete();
            events.delete(event.id);
            continue;
        }
    }
    
    toAdd.forEach(event => {
        //if (event.start < new Date()) return;
        if (events.find(i => i.scheduledStartAt.getTime() === event.start.getTime()) !== undefined) {
            console.log("Event exists, skipping...");
            return;
        }
        console.log(`Creating event ${event.summary} at ${event.start.toLocaleString("fr-FR", { timeZone: 'Europe/Paris' })}`);
        guild.scheduledEvents.create({
            name: event.summary,
            scheduledStartTime: event.start,
            scheduledEndTime: event.end,
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: GuildScheduledEventEntityType.External,
            description: event.description,
            entityMetadata: { location: event.location }
        })
    });
}

client.once('ready', async () => {
    console.log('Ready!');
    // Refresh calendar every 15 minutes
    schedule("*/15 * * * *", main);
    main();
});

// Login to Discord with your client's token
client.login(CONFIG.TOKEN);

// Serve calendar.ics
http.createServer((req, res) => {
    access("./calendar.ics", async (err) => {
        // File does not exist
        if (err) {
            console.log("calendar.ics does not exist");
            hook.send("calendar.ics does not exist"); // TODO: Proper discord errors
            res.writeHead(404);
            res.end();
            return;
        }
        
        // Return calendar.ics with proper response headers
        res.writeHead(200, { 
            'Content-Type': 'text/calendar',
            'Content-Disposition': "attachment; filename=calendar.ics"
        });
        res.end(readFileSync("./calendar.ics"));
    })})
    .listen(CONFIG.PORT, CONFIG.IP, () => {
        console.log(`Server running at http://${CONFIG.IP}:${CONFIG.PORT}/`);
    });
    