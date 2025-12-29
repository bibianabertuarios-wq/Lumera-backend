require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3000',
        'https://bibianabertuarios-wq.github.io', // TU DOMINIO GITHUB PAGES
        'https://lumera.app' // POR SI LO CAMBIAS
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Para webhook de Stripe (debe ser RAW BODY)
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));

// Para otros endpoints (JSON)
app.use(express.json());

// ============================================================
// INICIALIZAR SUPABASE
// ============================================================
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// LOGS Y DEBUGGING
// ============================================================
console.log(`
╔════════════════════════════════════════════╗
║  🚀 LUMERA BACKEND - STRIPE + SUPABASE   ║
╚════════════════════════════════════════════╝

📊 Entorno: ${process.env.NODE_ENV}
🔑 Stripe Secret Key: ${process.env.STRIPE_SECRET_KEY ? '✅ Cargada' : '❌ NO ENCONTRADA'}
🔐 Supabase URL: ${process.env.SUPABASE_URL ? '✅ Cargada' : '❌ NO ENCONTRADA'}

Price IDs:
  - LATAM: ${process.env.STRIPE_PRICE_LATAM_MONTHLY}
  - EMEA: ${process.env.STRIPE_PRICE_EMEA_MONTHLY}
  - USA: ${process.env.STRIPE_PRICE_USA_MONTHLY}
`);

// ============================================================
// ENDPOINT 1: HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
    res.json({
        status: '✅ Backend LUMERA funcionando',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV
    });
});

// ============================================================
// ENDPOINT 2: CREAR CHECKOUT SESSION (PAGO)
// ============================================================
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { userId, priceId, userEmail } = req.body;

        console.log(`\n💳 Nueva sesión de pago:`);
        console.log(`   Usuario: ${userId}`);
        console.log(`   Email: ${userEmail}`);
        console.log(`   Price ID: ${priceId}`);

        // Validar datos
        if (!userId || !priceId || !userEmail) {
            return res.status(400).json({
                error: 'Faltan datos requeridos: userId, priceId, userEmail'
            });
        }

        // Obtener o crear customer en Stripe
        let customerId;
        const { data: userData } = await supabase
            .from('user_profiles')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .single();

        if (userData?.stripe_customer_id) {
            customerId = userData.stripe_customer_id;
            console.log(`   ✅ Customer existente: ${customerId}`);
        } else {
            // Crear nuevo customer
            const customer = await stripe.customers.create({
                email: userEmail,
                metadata: {
                    user_id: userId,
                    created_at: new Date().toISOString()
                }
            });
            customerId = customer.id;

            // Guardar en Supabase
            await supabase
                .from('user_profiles')
                .update({ stripe_customer_id: customerId })
                .eq('user_id', userId);

            console.log(`   ✅ Nuevo customer creado: ${customerId}`);
        }

        // Crear checkout session
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            line_items: [{
                price: priceId,
                quantity: 1
            }],
            mode: 'subscription',
            success_url: `https://bibianabertuarios-wq.github.io?success=true`,
            cancel_url: `https://bibianabertuarios-wq.github.io?cancelled=true`,
            metadata: {
                user_id: userId
            },
            billing_address_collection: 'auto',
            locale: 'es'
        });

        console.log(`   ✅ Sesión creada: ${session.id}\n`);

        res.json({
            sessionId: session.id
        });

    } catch (error) {
        console.error('❌ Error en create-checkout-session:', error.message);
        res.status(500).json({
            error: error.message
        });
    }
});

// ============================================================
// ENDPOINT 3: WEBHOOK STRIPE
// ============================================================
app.post('/webhook/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error(`❌ Error verificando webhook: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`\n🔔 Webhook recibido: ${event.type}`);

    try {
        switch (event.type) {
            // =====================================================
            case 'checkout.session.completed':
                // =====================================================
                const session = event.data.object;
                console.log(`✅ Pago completado: ${session.id}`);
                console.log(`   Customer: ${session.customer}`);

                // Obtener subscripción
                const subscriptions = await stripe.subscriptions.list({
                    customer: session.customer,
                    limit: 1
                });

                if (subscriptions.data.length > 0) {
                    const subscription = subscriptions.data[0];
                    const userId = session.metadata.user_id;

                    // Actualizar usuario en Supabase (TABLA user_profiles)
                    const { error: updateError } = await supabase
                        .from('user_profiles')
                        .update({
                            subscription_status: 'active',
                            stripe_subscription_id: subscription.id,
                            stripe_customer_id: session.customer,
                            updated_at: new Date().toISOString()
                        })
                        .eq('user_id', userId);

                    if (updateError) {
                        console.error('Error actualizando perfil:', updateError);
                    } else {
                        console.log(`✅ Usuario ${userId} actualizado a Premium\n`);
                    }
                }
                break;

            // =====================================================
            case 'customer.subscription.updated':
                // =====================================================
                const updatedSub = event.data.object;
                console.log(`🔄 Suscripción actualizada: ${updatedSub.id}`);

                const { data: userWithSub } = await supabase
                    .from('user_profiles')
                    .select('user_id')
                    .eq('stripe_subscription_id', updatedSub.id)
                    .single();

                if (userWithSub) {
                    await supabase
                        .from('user_profiles')
                        .update({
                            subscription_status: updatedSub.status,
                            updated_at: new Date().toISOString()
                        })
                        .eq('user_id', userWithSub.user_id);

                    console.log(`✅ Suscripción actualizada: ${updatedSub.status}\n`);
                }
                break;

            // =====================================================
            case 'customer.subscription.deleted':
                // =====================================================
                const cancelledSub = event.data.object;
                console.log(`❌ Suscripción cancelada: ${cancelledSub.id}`);

                const { data: userWithCancelledSub } = await supabase
                    .from('user_profiles')
                    .select('user_id')
                    .eq('stripe_subscription_id', cancelledSub.id)
                    .single();

                if (userWithCancelledSub) {
                    await supabase
                        .from('user_profiles')
                        .update({
                            subscription_status: 'cancelled'
                        })
                        .eq('user_id', userWithCancelledSub.user_id);

                    console.log(`✅ Usuario ${userWithCancelledSub.user_id} canceló suscripción\n`);
                }
                break;

            default:
                console.log(`ℹ️ Evento no manejado: ${event.type}\n`);
        }

        res.json({ received: true });

    } catch (error) {
        console.error(`❌ Error procesando webhook:`, error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
    console.error('❌ Error no manejado:', err);
    res.status(500).json({
        error: 'Error interno del servidor',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`\n✅ Backend corriendo en puerto ${PORT}`);
    console.log(`📊 Entorno: ${process.env.NODE_ENV || 'production'}`);
    console.log(`🏥 Health check: /health`);
    console.log(`📊 Webhook: /webhook/stripe\n`);
});

// Manejar errores no capturados
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});
