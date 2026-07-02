import { QuickAddModal } from './components/QuickAddModal';

export function QuickAddWindowApp() {
    return (
        <div className="h-full bg-transparent text-foreground">
            <QuickAddModal standaloneWindow />
        </div>
    );
}
