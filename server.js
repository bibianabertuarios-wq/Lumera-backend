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
        'https://tudominio.com', // Cambiar a tu dominio
    ],
    credentials: true
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
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { userId, priceId, region, email, applyCoupon } = req.body;

        console.log(`\n💳 Nueva sesión de pago:`);
        console.log(`   Usuario: ${userId}`);
        console.log(`   Email: ${email}`);
        console.log(`   Región: ${region}`);
        console.log(`   Price ID: ${priceId}`);

        // Validar datos
        if (!userId || !priceId || !email) {
            return res.status(400).json({
                error: 'Faltan datos requeridos: userId, priceId, email'
            });
        }

        // Obtener o crear customer en Stripe
        let customerId;
        const { data: userData } = await supabase
            .from('users')
            .select('stripe_customer_id')
            .eq('id', userId)
            .single();

        if (userData?.stripe_customer_id) {
            customerId = userData.stripe_customer_id;
            console.log(`   ✅ Customer existente: ${customerId}`);
        } else {
            // Crear nuevo customer
            const customer = await stripe.customers.create({
                email: email,
                metadata: {
                    user_id: userId,
                    region: region,
                    created_at: new Date().toISOString()
                }
            });
            customerId = customer.id;

            // Guardar en Supabase
            await supabase
                .from('users')
                .update({ stripe_customer_id: customerId })
                .eq('id', userId);

            console.log(`   ✅ Nuevo customer creado: ${customerId}`);
        }

        // Construir line items
        const lineItems = [
            {
                price: priceId,
                quantity: 1
            }
        ];

        // Crear checkout session
        const sessionConfig = {
            customer: customerId,
            line_items: lineItems,
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/cancel`,
            metadata: {
                user_id: userId,
                region: region
            },
            billing_address_collection: 'auto',
            locale: 'es'
        };

        // Aplicar cupón si existe
        if (applyCoupon) {
            sessionConfig.discounts = [{
                coupon: process.env.STRIPE_COUPON_LAUNCH40 || 'LAUNCH40'
            }];
            console.log(`   🎉 Cupón aplicado: ${process.env.STRIPE_COUPON_LAUNCH40}`);
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);

        console.log(`   ✅ Sesión creada: ${session.id}\n`);

        res.json({
            success: true,
            sessionId: session.id,
            url: session.url,
            message: 'Sesión de pago creada exitosamente'
        });

    } catch (error) {
        console.error('❌ Error en create-checkout-session:', error.message);
        res.status(500).json({
            error: error.message,
            type: error.type
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

                    // Actualizar usuario en Supabase
                    const { error: updateError } = await supabase
                        .from('users')
                        .update({
                            subscription_status: 'active',
                            stripe_subscription_id: subscription.id,
                            stripe_customer_id: session.customer,
                            subscription_current_period_end: new Date(
                                subscription.current_period_end * 1000
                            ).toISOString()
                        })
                        .eq('id', userId);

                    if (updateError) throw updateError;

                    // Guardar en tabla de pagos (opcional)
                    await supabase
                        .from('payments')
                        .insert([{
                            user_id: userId,
                            stripe_session_id: session.id,
                            stripe_subscription_id: subscription.id,
                            amount: session.amount_total / 100,
                            currency: session.currency.toUpperCase(),
                            status: 'completed',
                            region: session.metadata.region
                        }]);

                    console.log(`✅ Usuario ${userId} actualizado a Premium`);
                    console.log(`   Próxima renovación: ${new Date(subscription.current_period_end * 1000).toISOString()}\n`);
                }
                break;

            // =====================================================
            case 'customer.subscription.updated':
                // =====================================================
                const updatedSub = event.data.object;
                console.log(`🔄 Suscripción actualizada: ${updatedSub.id}`);

                const { data: userWithSub } = await supabase
                    .from('users')
                    .select('id')
                    .eq('stripe_subscription_id', updatedSub.id)
                    .single();

                if (userWithSub) {
                    await supabase
                        .from('users')
                        .update({
                            subscription_status: updatedSub.status,
                            subscription_current_period_end: new Date(
                                updatedSub.current_period_end * 1000
                            ).toISOString()
                        })
                        .eq('id', userWithSub.id);

                    console.log(`✅ Suscripción actualizada: ${updatedSub.status}\n`);
                }
                break;

            // =====================================================
            case 'customer.subscription.deleted':
                // =====================================================
                const cancelledSub = event.data.object;
                console.log(`❌ Suscripción cancelada: ${cancelledSub.id}`);

                const { data: userWithCancelledSub } = await supabase
                    .from('users')
                    .select('id')
                    .eq('stripe_subscription_id', cancelledSub.id)
                    .single();

                if (userWithCancelledSub) {
                    await supabase
                        .from('users')
                        .update({
                            subscription_status: 'cancelled'
                        })
                        .eq('id', userWithCancelledSub.id);

                    console.log(`✅ Usuario ${userWithCancelledSub.id} canceló suscripción\n`);
                }
                break;

            // =====================================================
            case 'invoice.payment_succeeded':
                // =====================================================
                const invoice = event.data.object;
                console.log(`💰 Pago procesado: ${invoice.id}`);
                console.log(`   Monto: ${(invoice.amount_paid / 100).toFixed(2)} ${invoice.currency.toUpperCase()}\n`);
                break;

            // =====================================================
            case 'invoice.payment_failed':
                // =====================================================
                const failedInvoice = event.data.object;
                console.log(`⚠️ Pago fallido: ${failedInvoice.id}\n`);
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
// ENDPOINT 4: OBTENER ESTADO DE SUSCRIPCIÓN
// ============================================================
app.get('/api/subscription/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const { data: user, error } = await supabase
            .from('users')
            .select('subscription_status, subscription_current_period_end')
            .eq('id', userId)
            .single();

        if (error) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({
            userId: userId,
            status: user.subscription_status || 'free',
            currentPeriodEnd: user.subscription_current_period_end,
            isPremium: user.subscription_status === 'active'
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// ENDPOINT 5: CANCELAR SUSCRIPCIÓN
// ============================================================
app.post('/api/cancel-subscription', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'userId requerido' });
        }

        const { data: user } = await supabase
            .from('users')
            .select('stripe_subscription_id')
            .eq('id', userId)
            .single();

        if (!user?.stripe_subscription_id) {
            return res.status(400).json({ error: 'Sin suscripción activa' });
        }

        // Cancelar en Stripe
        await stripe.subscriptions.del(user.stripe_subscription_id);

        // Actualizar en Supabase
        await supabase
            .from('users')
            .update({ subscription_status: 'cancelled' })
            .eq('id', userId);

        console.log(`✅ Suscripción cancelada para usuario ${userId}`);

        res.json({
            success: true,
            message: 'Suscripción cancelada exitosamente'
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// ENDPOINT 6: LISTAR PRECIOS (PARA DEBUG)
// ============================================================
app.get('/api/prices', (req, res) => {
    res.json({
        prices: {
            latam: {
                id: process.env.STRIPE_PRICE_LATAM_MONTHLY,
                price: '$4.99',
                currency: 'USD',
                region: 'Latinoamérica'
            },
            emea: {
                id: process.env.STRIPE_PRICE_EMEA_MONTHLY,
                price: '€4.99',
                currency: 'EUR',
                region: 'Europa/EMEA'
            },
            usa: {
                id: process.env.STRIPE_PRICE_USA_MONTHLY,
                price: '$6.99',
                currency: 'USD',
                region: 'USA/Canadá'
            }
        }
    });
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
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`\n✅ Backend corriendo en http://${HOST}:${PORT}`);
    console.log(`📊 Webhook: http://${HOST}:${PORT}/webhook/stripe`);
    console.log(`🏥 Health: http://${HOST}:${PORT}/health\n`);
});
