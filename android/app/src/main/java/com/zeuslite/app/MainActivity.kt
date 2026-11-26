package com.zeuslite.app

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.VpnService
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Update
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/* ------------------------------------------------------------------ theme */

private val Ink = Color(0xFF07080F)
private val Ink2 = Color(0xFF10142A)
private val CardBg = Color(0xFF141A33)
private val Accent = Color(0xFF5B8CFF)
private val Accent2 = Color(0xFFA855F7)
private val Mint = Color(0xFF22D3A7)
private val Danger = Color(0xFFFF5D73)
private val Muted = Color(0xFF9AA4C8)

/** The words, in the two languages the panel speaks. */
class Words(private val en: Boolean) {
    val configs get() = if (en) "Configs" else "کانفیگ‌ها"
    val connect get() = if (en) "Connect" else "اتصال"
    val connected get() = if (en) "Connected" else "متصل"
    val connecting get() = if (en) "Connecting…" else "در حال اتصال…"
    val disconnected get() = if (en) "Not connected" else "قطع"
    val disconnect get() = if (en) "Disconnect" else "قطع اتصال"
    val add get() = if (en) "Add config" else "افزودن کانفیگ"
    val paste get() = if (en) "Paste link" else "چسباندن لینک"
    val link get() = if (en) "vless:// link" else "لینک vless://"
    val save get() = if (en) "Save" else "ذخیره"
    val cancel get() = if (en) "Cancel" else "انصراف"
    val subscription get() = if (en) "Subscription" else "لینک اشتراک"
    val subscriptionUrl get() = if (en) "Subscription URL" else "آدرس لینک اشتراک"
    val update get() = if (en) "Update" else "به‌روزرسانی"
    val empty get() = if (en) "No configs yet. Paste a link or add your subscription." else "هنوز کانفیگی نیست. لینک را بچسبانید یا لینک اشتراک را وارد کنید."
    val delete get() = if (en) "Delete" else "حذف"
    val share get() = if (en) "Share" else "اشتراک‌گذاری"
    val qr get() = if (en) "QR code" else "کد QR"
    val added get() = if (en) "added" else "اضافه شد"
    val failed get() = if (en) "Failed" else "نشد"
    val copied get() = if (en) "Copied" else "کپی شد"
    val timer get() = if (en) "up" else "مدت"
    val choose get() = if (en) "Tap a config, then connect" else "یک کانفیگ را انتخاب و وصل شوید"
}

private fun ZeusTheme(content: @Composable () -> Unit) {
    androidx.compose.material3.MaterialTheme(
        colorScheme = androidx.compose.material3.darkColorScheme(
            primary = Accent,
            onPrimary = Color.White,
            secondary = Accent2,
            background = Ink,
            surface = CardBg,
            onSurface = Color.White,
        ),
    ) { content() }
}

/* ------------------------------------------------------------------ activity */

class MainActivity : ComponentActivity() {

    private var pending: Profile? = null

    private val askPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val profile = pending
        pending = null
        if (result.resultCode == Activity.RESULT_OK && profile != null) {
            ZeusVpnService.start(this, profile.link, profile.name)
        } else {
            TunnelState.message = "اجازه VPN داده نشد / VPN permission was not granted"
        }
    }

    /** Ask Android for the VPN permission once, then start the service. */
    fun connect(profile: Profile) {
        val request = VpnService.prepare(this)
        if (request != null) {
            pending = profile
            askPermission.launch(request)
        } else {
            ZeusVpnService.start(this, profile.link, profile.name)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val lang = Store.lang(this)
        setContent { ZeusTheme { App(lang) } }
    }
}

/* ------------------------------------------------------------------ ui */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun App(initialLang: String) {
    val context = LocalContext.current
    val activity = context as MainActivity
    val scope = rememberCoroutineScope()
    var lang by remember { mutableStateOf(initialLang) }
    val t = remember(lang) { Words(lang == "en") }
    var profiles by remember { mutableStateOf(Store.load(context)) }
    var selected by remember { mutableStateOf(profiles.firstOrNull()?.id) }
    var adding by remember { mutableStateOf(false) }
    var subscribing by remember { mutableStateOf(false) }
    var qrFor by remember { mutableStateOf<Profile?>(null) }
    var message by remember { mutableStateOf("") }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }

    LaunchedEffect(TunnelState.connected) {
        while (TunnelState.connected) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }

    fun refresh() {
        profiles = Store.load(context)
        if (profiles.none { it.id == selected }) selected = profiles.firstOrNull()?.id
    }

    Scaffold(containerColor = Color.Transparent) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .background(Brush.verticalGradient(listOf(Ink, Ink2, Ink)))
                .padding(padding)
                .imePadding(),
        ) {
            LazyColumn(
                Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                contentPadding = WindowInsets.statusBars.asPaddingValues(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { Header(lang, t) { lang = it; Store.setLang(context, it) } }

                item {
                    StatusCard(
                        t = t,
                        now = now,
                        onToggle = {
                            val profile = profiles.firstOrNull { it.id == selected }
                            if (TunnelState.connected || TunnelState.busy) {
                                ZeusVpnService.stop(context)
                            } else if (profile != null) {
                                activity.connect(profile)
                            } else {
                                message = t.empty
                            }
                        },
                        onSubscribe = { subscribing = true },
                    )
                }

                item {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(top = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(t.configs, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.width(8.dp))
                        CountChip(profiles.size)
                        Spacer(Modifier.weight(1f))
                        Button(
                            onClick = { adding = true },
                            shape = RoundedCornerShape(14.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Accent),
                        ) {
                            Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(t.add, fontSize = 13.sp)
                        }
                    }
                }

                if (profiles.isEmpty()) {
                    item {
                        Card(
                            shape = RoundedCornerShape(20.dp),
                            colors = CardDefaults.cardColors(containerColor = CardBg.copy(alpha = 0.6f)),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                t.empty,
                                color = Muted,
                                fontSize = 13.sp,
                                textAlign = TextAlign.Center,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(28.dp),
                            )
                        }
                    }
                }

                items(profiles, key = { it.id }) { profile ->
                    ProfileCard(
                        profile = profile,
                        selected = profile.id == selected,
                        active = TunnelState.connected && profile.name == TunnelState.activeName,
                        onSelect = { selected = profile.id },
                        onDelete = {
                            profiles = Store.remove(context, profile.id)
                            if (selected == profile.id) selected = profiles.firstOrNull()?.id
                        },
                        onQr = { qrFor = profile },
                        onShare = { share(context, profile.link) },
                        t = t,
                    )
                }

                item { Spacer(Modifier.height(28.dp)) }
                item {
                    if (message.isNotEmpty()) {
                        Text(
                            message,
                            color = Danger,
                            fontSize = 12.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(bottom = 12.dp),
                        )
                    }
                }
            }
        }
    }

    if (adding) {
        AddDialog(
            t = t,
            onPaste = {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.primaryClip?.getItemAt(0)?.text?.toString().orEmpty()
            },
            onDismiss = { adding = false },
            onAdd = { link ->
                val profile = Links.parse(link)
                if (profile == null) {
                    message = "${t.failed}: ${t.link}"
                } else {
                    profiles = Store.add(context, profile)
                    selected = profiles.first().id
                    adding = false
                    message = "${profile.name} ${t.added}"
                }
            },
        )
    }

    if (subscribing) {
        SubscriptionDialog(
            t = t,
            initial = Store.subscription(context),
            onDismiss = { subscribing = false },
            onFetch = { url, done ->
                scope.launch {
                    runCatching {
                        withContext(Dispatchers.IO) { Links.fetch(url) }
                    }.onSuccess { body ->
                        val found = Links.parseMany(body)
                        var list = Store.load(context)
                        found.forEach { list = Store.add(context, it) }
                        Store.setSubscription(context, url)
                        profiles = list
                        selected = profiles.firstOrNull()?.id
                        message = if (found.isEmpty()) "${t.failed}: no config in the answer" else "${found.size} ${t.added}"
                        subscribing = false
                    }.onFailure { message = "${t.failed}: ${it.message}" }
                    done()
                }
            },
        )
    }

    qrFor?.let { profile ->
        QrDialog(profile = profile, t = t, onClose = { qrFor = null })
    }
}

@Composable
private fun Header(lang: String, t: Words, onLang: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(42.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(Brush.linearGradient(listOf(Accent, Accent2))),
            contentAlignment = Alignment.Center,
        ) {
            Text("Z", color = Color.White, fontWeight = FontWeight.Black, fontSize = 22.sp)
        }
        Spacer(Modifier.width(12.dp))
        Column {
            Text("ZEUS LITE", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 17.sp, letterSpacing = 1.sp)
            Text(if (lang == "en") "fast configs" else "کانفیگ‌های سریع", color = Muted, fontSize = 11.sp)
        }
        Spacer(Modifier.weight(1f))
        LangChip("فا", lang == "fa") { onLang("fa") }
        Spacer(Modifier.width(6.dp))
        LangChip("EN", lang == "en") { onLang("en") }
    }
}

@Composable
private fun LangChip(label: String, active: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(if (active) Accent.copy(alpha = 0.22f) else Color.White.copy(alpha = 0.05f))
            .border(1.dp, if (active) Accent.copy(alpha = 0.6f) else Color.White.copy(alpha = 0.1f), RoundedCornerShape(10.dp))
            .clickable { onClick() }
            .padding(horizontal = 11.dp, vertical = 7.dp),
    ) {
        Text(label, color = if (active) Color.White else Muted, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun CountChip(count: Int) {
    Box(
        Modifier
            .clip(CircleShape)
            .background(Color.White.copy(alpha = 0.08f))
            .padding(horizontal = 9.dp, vertical = 3.dp),
    ) {
        Text("$count", color = Muted, fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun StatusCard(t: Words, now: Long, onToggle: () -> Unit, onSubscribe: () -> Unit) {
    val connected = TunnelState.connected
    val busy = TunnelState.busy
    Card(
        shape = RoundedCornerShape(26.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg.copy(alpha = 0.72f)),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 6.dp)
            .border(1.dp, Color.White.copy(alpha = 0.07f), RoundedCornerShape(26.dp)),
    ) {
        Column(Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(9.dp)
                        .clip(CircleShape)
                        .background(if (connected) Mint else Muted),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    when {
                        busy -> t.connecting
                        connected -> t.connected
                        else -> t.disconnected
                    },
                    color = if (connected) Mint else Muted,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.weight(1f))
                if (connected && TunnelState.since > 0) {
                    val seconds = ((now - TunnelState.since) / 1000).coerceAtLeast(0)
                    Text(
                        "%s %02d:%02d:%02d".format(t.timer, seconds / 3600, (seconds % 3600) / 60, seconds % 60),
                        color = Muted,
                        fontSize = 11.sp,
                    )
                }
            }

            Spacer(Modifier.height(18.dp))

            Box(contentAlignment = Alignment.Center) {
                Box(
                    Modifier
                        .size(128.dp)
                        .clip(CircleShape)
                        .background(
                            Brush.radialGradient(
                                if (connected) listOf(Mint.copy(alpha = 0.35f), Color.Transparent)
                                else listOf(Accent.copy(alpha = 0.28f), Color.Transparent),
                            ),
                        ),
                )
                Box(
                    Modifier
                        .size(88.dp)
                        .clip(CircleShape)
                        .background(Brush.linearGradient(if (connected) listOf(Mint, Color(0xFF14A38A)) else listOf(Accent, Accent2)))
                        .clickable { onToggle() },
                    contentAlignment = Alignment.Center,
                ) {
                    if (busy) {
                        CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(30.dp))
                    } else {
                        Icon(
                            Icons.Filled.PowerSettingsNew,
                            contentDescription = t.connect,
                            tint = Color.White,
                            modifier = Modifier.size(34.dp),
                        )
                    }
                }
            }

            Spacer(Modifier.height(14.dp))
            Text(
                when {
                    connected -> TunnelState.activeName.ifBlank { t.connected }
                    busy -> t.connecting
                    else -> t.choose
                },
                color = Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (TunnelState.message.isNotBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    TunnelState.message,
                    color = Danger,
                    fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(16.dp))
            TextButton(onClick = onSubscribe) {
                Icon(Icons.Filled.Update, contentDescription = null, tint = Accent, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(6.dp))
                Text(t.subscription, color = Accent, fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun ProfileCard(
    profile: Profile,
    selected: Boolean,
    active: Boolean,
    onSelect: () -> Unit,
    onDelete: () -> Unit,
    onQr: () -> Unit,
    onShare: () -> Unit,
    t: Words,
) {
    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = if (selected) Color(0xFF1B2344) else CardBg.copy(alpha = 0.6f)),
        modifier = Modifier
            .fillMaxWidth()
            .border(
                1.dp,
                if (selected) Accent.copy(alpha = 0.55f) else Color.White.copy(alpha = 0.06f),
                RoundedCornerShape(20.dp),
            )
            .clickable { onSelect() },
    ) {
        Row(Modifier.padding(start = 16.dp, top = 14.dp, bottom = 14.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(38.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (active) Mint.copy(alpha = 0.18f) else Accent.copy(alpha = 0.14f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Bolt, contentDescription = null, tint = if (active) Mint else Accent, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    profile.name,
                    color = Color.White,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    "${profile.protocol} · ${profile.endpoint} · ${profile.network}",
                    color = Muted,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = onQr) {
                Icon(Icons.Filled.QrCode2, contentDescription = t.qr, tint = Muted, modifier = Modifier.size(19.dp))
            }
            IconButton(onClick = onShare) {
                Icon(Icons.Filled.Share, contentDescription = t.share, tint = Muted, modifier = Modifier.size(18.dp))
            }
            IconButton(onClick = onDelete) {
                Icon(Icons.Filled.Delete, contentDescription = t.delete, tint = Danger.copy(alpha = 0.85f), modifier = Modifier.size(18.dp))
            }
        }
    }
}

/* ------------------------------------------------------------------ dialogs */

@Composable
private fun fieldColors() = TextFieldDefaults.colors(
    focusedContainerColor = Color(0xFF0C1022),
    unfocusedContainerColor = Color(0xFF0C1022),
    focusedTextColor = Color.White,
    unfocusedTextColor = Color.White,
    focusedIndicatorColor = Accent,
    unfocusedIndicatorColor = Color.White.copy(alpha = 0.12f),
    cursorColor = Accent,
)

@Composable
private fun AddDialog(t: Words, onPaste: () -> String, onDismiss: () -> Unit, onAdd: (String) -> Unit) {
    var link by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = CardBg,
        title = { Text(t.add, color = Color.White) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = link,
                    onValueChange = { link = it },
                    label = { Text(t.link, fontSize = 12.sp) },
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp, color = Color.White),
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 5,
                )
                Spacer(Modifier.height(10.dp))
                TextButton(onClick = { link = onPaste() }) {
                    Icon(Icons.Filled.ContentPaste, contentDescription = null, tint = Accent, modifier = Modifier.size(17.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(t.paste, color = Accent, fontSize = 12.sp)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onAdd(link) }, enabled = link.isNotBlank()) {
                Text(t.save, color = Accent, fontWeight = FontWeight.Bold)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(t.cancel, color = Muted) } },
    )
}

@Composable
private fun SubscriptionDialog(
    t: Words,
    initial: String,
    onDismiss: () -> Unit,
    onFetch: (String, () -> Unit) -> Unit,
) {
    var url by remember { mutableStateOf(initial) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        containerColor = CardBg,
        title = { Text(t.subscription, color = Color.White) },
        text = {
            Column {
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text(t.subscriptionUrl, fontSize = 12.sp) },
                    singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp, color = Color.White),
                    colors = fieldColors(),
                    keyboardOptions = KeyboardOptions(autoCorrect = false),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = url.isNotBlank() && !busy,
                onClick = {
                    busy = true
                    onFetch(url.trim()) { busy = false }
                },
            ) {
                if (busy) {
                    CircularProgressIndicator(color = Accent, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                } else {
                    Text(t.update, color = Accent, fontWeight = FontWeight.Bold)
                }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(t.cancel, color = Muted) } },
    )
}

@Composable
private fun QrDialog(profile: Profile, t: Words, onClose: () -> Unit) {
    val bitmap = remember(profile.link) { qr(profile.link) }
    Dialog(onDismissRequest = onClose) {
        Card(shape = RoundedCornerShape(24.dp), colors = CardDefaults.cardColors(containerColor = CardBg)) {
            Column(Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(profile.name, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = t.cancel, tint = Muted) }
                }
                Spacer(Modifier.height(10.dp))
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = t.qr,
                    modifier = Modifier
                        .size(240.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(Color.White),
                )
                Spacer(Modifier.height(10.dp))
                Text(profile.endpoint, color = Muted, fontSize = 12.sp)
            }
        }
    }
}

/* ------------------------------------------------------------------ helpers */

private fun qr(text: String, size: Int = 660) = runCatching {
    val matrix = QRCodeWriter().encode(
        text,
        BarcodeFormat.QR_CODE,
        size,
        size,
        mapOf(EncodeHintType.MARGIN to 1, EncodeHintType.CHARACTER_SET to "UTF-8"),
    )
    val pixels = IntArray(size * size)
    for (y in 0 until size) {
        for (x in 0 until size) {
            pixels[y * size + x] = if (matrix.get(x, y)) 0xFF07080F.toInt() else 0xFFFFFFFF.toInt()
        }
    }
    Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
}.getOrElse {
    Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
}

private fun share(context: Context, text: String) {
    runCatching {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }
        context.startActivity(Intent.createChooser(intent, "Zeus Lite").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

