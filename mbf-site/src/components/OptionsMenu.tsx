import { Adb, decodeUtf8 } from '@yume-chan/adb';
import { uninstallBeatSaber } from '../DeviceModder';
import { useEffect, useRef, useState } from 'react';
import { fixPlayerData, patchApp, quickFix } from '../Agent';
import { toast } from 'react-toastify';
import { ErrorModal, Modal, SyncingModal } from './Modal';
import { PermissionsMenu } from './PermissionsMenu';
import '../css/OptionsMenu.css'
import { Collapsible } from './Collapsible';
import { useLog } from './LogWindow';
import { ModStatus } from '../Messages';
import { AndroidManifest } from '../AndroidManifest';

export function OptionsMenu({ device, quit, modStatus, setModStatus }: {
    device: Adb,
    setModStatus: (status: ModStatus) => void,
    quit: (err: unknown | null) => void
    modStatus: ModStatus}) {
    return <div className="container mainContainer" id="toolsContainer">
        <Collapsible title="Mod tools" defaultOpen>
            <ModTools device={device} modStatus={modStatus} setModStatus={setModStatus} quit={() => quit(null)} />
        </Collapsible>
        <Collapsible title="ADB log" defaultOpen>
            <AdbLogger device={device}/>
        </Collapsible>
        <Collapsible title="Change permissions">
            <RepatchMenu device={device} quit={quit} modStatus={modStatus}/>
        </Collapsible>
    </div>
}

// Basic tools to do with managing the install, including a fix for a previously introduced bug.
function ModTools({ device, quit, modStatus, setModStatus }: {
    device: Adb,
    quit: () => void,
    modStatus: ModStatus,
    setModStatus: (status: ModStatus) => void}) {
    const [err, setErr] = useState(null as string | null);
    const [isWorking, setWorking] = useState(false);
    const [logEvents, addLogEvent] = useLog();

    return <div id="modTools">
        <button onClick={async () => {
            try {
                await device.subprocess.spawnAndWait("am force-stop com.beatgames.beatsaber");
                toast.success("Successfully killed Beat Saber");
            }   catch(e) {
                setErr("Failed to kill Beat Saber process " + e);
            }
        }}>Kill Beat Saber</button>
        Immediately closes the game.

        <br />
        <button onClick={async () => {
            try {
                setWorking(true);
                setModStatus(await quickFix(device, modStatus, true, addLogEvent));
                toast.success("All non-core mods removed!");
            }   catch(e) {
                setErr("Failed to uninstall all mods " + e);
            }   finally {
                setWorking(false);
            }

        }}>Reinstall only core mods</button>
        Deletes all installed mods, then installs only the core mods.
        <br/>

        <button onClick={async () => {
            try {
                await uninstallBeatSaber(device);
                quit();
            }   catch(e)   {
                setErr("Failed to uninstall Beat Saber " + e)
            }
        }}>Uninstall Beat Saber</button>
        Uninstalls the game: this will remove all mods and quit MBF.
        <br/>

        <button onClick={async () => {
            try {
                if(await fixPlayerData(device)) {
                    toast.success("Successfully fixed player data issues");
                }   else    {
                    toast.error("No player data file found to fix");
                }
            }   catch(e) {
                setErr("Failed to fix player data " + e);
            }
        }}>Fix Player Data</button>
        Fixes an issue with player data permissions.
        
        <br/>

        <ErrorModal
            title="Operation failed"
            description={err!}
            isVisible={err !== null}
            onClose={() => setErr(null)}
        />

        <SyncingModal title="Reinstalling only core mods" logEvents={logEvents} isVisible={isWorking}/>
    </div>
}

function RepatchMenu({ device, modStatus, quit }: {
    device: Adb,
    modStatus: ModStatus,
    quit: (err: unknown) => void}) {

    let manifest = useRef(new AndroidManifest(modStatus.app_info!.manifest_xml));
    useEffect(() => {
        manifest.current.applyPatchingManifestMod();
    }, []);

    const [logs, addLogEvent] = useLog();
    const [isPatching, setPatching] = useState(false);

    return <>
        <p>Certain mods require particular Android permissions to be enabled in order to work. 
            To change the permisions, you will need to re-patch your game, which can be done automatically with the button below.</p>
        <PermissionsMenu manifest={manifest.current} />
        <br/>
        <button onClick={async () => {
            setPatching(true);
            try {
                // TODO: Right now we do not set the mod status back to the DeviceModder state for it.
                // This is fine at the moment since repatching does not update this state in any important way,
                // but would be a problem if repatching did update it!
                await patchApp(device, modStatus, null, manifest.current.toString(), true, false, addLogEvent);
                toast.success("Successfully applied permissions");
            }   catch(e) {
                // Force a quit so the app rechecks the state of the install is correct.
                quit("Failed to remod Beat Saber: the install is now likely in an invalid state!: " + e);
            }   finally {
                setPatching(false);
            }
        }}>Repatch game</button>

        <SyncingModal title="Repatching Beat Saber" isVisible={isPatching} logEvents={logs} />
    </>
}

// Starts recording log messages from `adb logcat`. The promise returned will not complete until `getCancelled` returns a `true` value.
// Returns a blob containing the logcat messages recorded.
async function logcatToBlob(device: Adb, getCancelled: () => boolean): Promise<Blob> {
    console.log("Starting `logcat` process");

    // First clear the logcat buffer - we only want logs from events happening after the "start logcat" button is pressed.
    await device.subprocess.spawnAndWait("logcat -c");
    
    const process = await device.subprocess.spawn("logcat");
    let killed = false;

    console.log("Generating logs");
    const stdout = process.stdout.getReader();
    const logs = [];

    while(true) {
        const bytesRead = (await stdout.read()).value;
        if(bytesRead != null) {
            logs.push(decodeUtf8(bytesRead));
        }   else    {
            break;
        }

        // NB: It is vital that, after we kill logcat, we read any messages that have not yet been read
        // before returning. Otherwise, the unread messages cause the ADB implementation to hang on all future requests!
        if(getCancelled() && !killed) {
            console.log("Killing `logcat` process");
            await process.kill();
            killed = true;
        }
    }

    console.log("Providing blob of logs");
    return new Blob(logs, { type: 'text/plain' })
}

function AdbLogger({ device }: { device: Adb }) {
    const [logging, setLogging] = useState(false);
    const [logFile, setLogFile] = useState(null as Blob | null);
    const [waitingForLog, setWaitingForLog] = useState(false);

    useEffect(() => {
        if(!logging) {
            return () => {};
        }

        // Begin gathering logs, making sure to remove the previous log file/blob
        setWaitingForLog(false);
        setLogFile(null);
        let cancelled = false;
        logcatToBlob(device, () => cancelled)
            .then(log => {
                setLogFile(log);
                setWaitingForLog(false);
            })
            .catch(e => console.error("Failed to get ADB log " + e));
        
        // When the value of `logging` changes to false, use the cleanup function to tell the `log` function to stop getting logs as soon as it can.
        return () => {
            cancelled = true;
            setWaitingForLog(true);
        };
    }, [logging]);

    return <>
        <p>This feature allows you to get a log of what's going on inside your Quest, useful for modders to fix bugs with their mods.</p>
        <p>Click the button below, <span className="warning">and keep your headset plugged in.</span> Open the game and do whatever it is that was causing you issues, then click the button again.</p>

        <p className="warning"></p>
        {!logging ? 
            <button onClick={async () => setLogging(true)}>Start Logging</button> : 
            <button onClick={() => setLogging(false)}>Stop Logging</button>}
            <br/>

        {waitingForLog && <p>Please wait while the log file generates . . .</p>}
        {logFile !== null && <a href={URL.createObjectURL(logFile)} download={"logcat.log"}><button>Download Log</button></a>}
    </>
}